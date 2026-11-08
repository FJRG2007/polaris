/**
 * Answering a Claude session's permission prompt from anywhere.
 *
 * Claude Code runs a `PermissionRequest` hook when it is about to ask for
 * permission, and the hook may answer for the person
 * (https://code.claude.com/docs/en/hooks#permissionrequest-decision-control).
 * Polaris's hook posts the request here and waits a bounded time. In that time
 * the request is shown on the session page and pushed to the owner's devices
 * with Allow / Deny buttons; whichever answer lands first is the decision. If
 * nobody answers in time the hook prints nothing and the agent's own prompt in
 * the terminal is the one that counts, exactly as before.
 *
 * An answer is a conditional write on a pending row, so pressing twice, or on
 * two devices, records one answer and reports it to both.
 */

import { z } from "zod";
import { prisma, type Prisma } from "@polaris/db";
import { normalizeHookEvent } from "./session-hooks";
import { touchSession, subscribeSession } from "./session-live";

/** How long the hook waits for an answer. The hook's own curl and Claude's
 *  timeout for it are a little longer (see session-hooks), so the server is
 *  always the side that gives up first and answers "no decision". */
export const PERMISSION_WAIT_MS = 120_000;

export const PERMISSION_CHOICES = ["allow", "deny", "always"] as const;
export type PermissionChoice = (typeof PERMISSION_CHOICES)[number];

export type PermissionStatus = PermissionChoice | "pending" | "expired";

export const permissionAnswerSchema = z.object({
    requestId: z.string().trim().uuid(),
    choice: z.enum(PERMISSION_CHOICES)
});

/** The kinds of event after which a prompt is no longer the one on screen. */
const SETTLING_KINDS = new Set(["prompt", "turn.end", "turn.failed", "session.end", "session.clear"]);

export function settlesPermissions(kind: string): boolean {
    return SETTLING_KINDS.has(kind);
}

/** The most of the agent's suggestions worth keeping. */
const MAX_SUGGESTIONS_BYTES = 8 * 1024;

const suggestionSchema = z
    .object({ type: z.string().max(40), destination: z.string().max(40).optional() })
    .passthrough();

/**
 * What a PermissionRequest payload asks, or null when it is not one.
 * Pure: the payload is the agent's, and only what passes is kept.
 */
export function readPermissionRequest(
    payload: unknown
): { tool: string; detail: string; suggestions: Prisma.InputJsonValue | null } | null {
    const event = normalizeHookEvent(payload);
    if (!event || event.kind !== "permission") return null;
    const raw = (payload as Record<string, unknown>).permission_suggestions;
    let suggestions: Prisma.InputJsonValue | null = null;
    if (Array.isArray(raw)) {
        const kept = raw.filter((entry) => suggestionSchema.safeParse(entry).success);
        const text = JSON.stringify(kept);
        if (kept.length > 0 && text.length <= MAX_SUGGESTIONS_BYTES)
            suggestions = kept as Prisma.InputJsonValue;
    }
    return { tool: event.subject.slice(0, 80), detail: event.detail, suggestions };
}

/** Permission updates "always allow" may apply: rules and directories, for this
 *  session only. Never a mode change - that is a bigger grant than the prompt
 *  on screen, and bypass in particular is not Polaris's to switch on. */
const ALWAYS_TYPES = new Set(["addRules", "addDirectories"]);

/**
 * The hook's standard output for a status. Pure.
 *
 * `{}` for anything not answered: no decision, so the agent asks in its own
 * terminal. "always" replays the agent's own suggestions with the destination
 * forced to `session`, so nothing is written into the repository's settings;
 * with no usable suggestion it allows the whole tool for the session.
 */
export function hookDecision(
    status: PermissionStatus,
    tool: string,
    suggestions: unknown
): Record<string, unknown> {
    if (status === "pending" || status === "expired") return {};
    if (status === "deny") {
        return {
            hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: { behavior: "deny", message: "Denied from Polaris by the session owner." }
            }
        };
    }
    const decision: Record<string, unknown> = { behavior: "allow" };
    if (status === "always") {
        const offered = Array.isArray(suggestions) ? suggestions : [];
        const updates = offered
            .filter(
                (entry): entry is Record<string, unknown> =>
                    Boolean(entry) &&
                    typeof entry === "object" &&
                    ALWAYS_TYPES.has(String((entry as Record<string, unknown>).type))
            )
            .map((entry) => ({ ...entry, destination: "session" }));
        decision.updatedPermissions =
            updates.length > 0
                ? updates
                : [
                      {
                          type: "addRules",
                          rules: [{ toolName: tool }],
                          behavior: "allow",
                          destination: "session"
                      }
                  ];
    }
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

/** Record a new prompt. Any older pending one of the session is over: the agent
 *  shows one prompt at a time. */
export async function openPermissionRequest(
    sessionId: string,
    request: { tool: string; detail: string; suggestions: Prisma.InputJsonValue | null }
): Promise<string> {
    await prisma.agentPermissionRequest.updateMany({
        where: { sessionId, status: "pending" },
        data: { status: "expired" }
    });
    const row = await prisma.agentPermissionRequest.create({
        data: {
            sessionId,
            tool: request.tool || "tool",
            detail: request.detail,
            ...(request.suggestions !== null ? { suggestions: request.suggestions } : {})
        },
        select: { id: true }
    });
    touchSession(sessionId);
    return row.id;
}

/** Mark the session's pending prompts expired, because the agent moved on. */
export async function expirePermissions(sessionId: string): Promise<void> {
    const moved = await prisma.agentPermissionRequest.updateMany({
        where: { sessionId, status: "pending" },
        data: { status: "expired" }
    });
    if (moved.count > 0) touchSession(sessionId);
}

const POLL_MS = 1000;

/**
 * Wait for the request to be answered, up to `waitMs` or until `signal` aborts.
 * Woken at once by an answer in this process, and reads the row every second
 * for one written by another. A request still pending at the end is expired, so
 * the page stops offering buttons nobody is listening to.
 */
export async function awaitPermission(
    requestId: string,
    sessionId: string,
    waitMs: number = PERMISSION_WAIT_MS,
    signal?: AbortSignal
): Promise<{ status: PermissionStatus; tool: string; suggestions: unknown }> {
    const deadline = Date.now() + waitMs;
    let wake: (() => void) | null = null;
    const unsubscribe = subscribeSession(sessionId, () => wake?.());
    try {
        for (;;) {
            const row = await prisma.agentPermissionRequest.findUnique({
                where: { id: requestId },
                select: { status: true, tool: true, suggestions: true }
            });
            if (!row) return { status: "expired", tool: "", suggestions: null };
            if (row.status !== "pending")
                return {
                    status: row.status as PermissionStatus,
                    tool: row.tool,
                    suggestions: row.suggestions
                };
            const left = deadline - Date.now();
            if (left <= 0 || signal?.aborted) {
                await prisma.agentPermissionRequest.updateMany({
                    where: { id: requestId, status: "pending" },
                    data: { status: "expired" }
                });
                touchSession(sessionId);
                return { status: "expired", tool: row.tool, suggestions: row.suggestions };
            }
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, Math.min(POLL_MS, left));
                wake = () => {
                    clearTimeout(timer);
                    resolve();
                };
                signal?.addEventListener("abort", () => wake?.(), { once: true });
            });
            wake = null;
        }
    } finally {
        unsubscribe();
    }
}

/** A pending prompt as the session page shows it. */
export interface PendingPermission {
    readonly id: string;
    readonly tool: string;
    readonly detail: string;
    readonly at: string;
}

export async function pendingPermission(sessionId: string): Promise<PendingPermission | null> {
    const row = await prisma.agentPermissionRequest.findFirst({
        where: { sessionId, status: "pending" },
        orderBy: { createdAt: "desc" },
        select: { id: true, tool: true, detail: true, createdAt: true }
    });
    return row
        ? { id: row.id, tool: row.tool, detail: row.detail, at: row.createdAt.toISOString() }
        : null;
}

export type AnswerOutcome =
    | { readonly ok: true; readonly status: PermissionChoice }
    | { readonly ok: false; readonly reason: "gone" | "expired" | "answered" };

/**
 * Record an answer from somebody who may control the session.
 *
 * `canControl` is the caller's check that this account may steer the session -
 * the same one prompting it uses - run against the request's own session, so a
 * request id from another session gets nowhere. Idempotent: the same answer
 * again is a success, a different one after it is reported as already answered.
 */
export async function answerPermission(
    requestId: string,
    choice: PermissionChoice,
    userId: string,
    canControl: (sessionId: string) => Promise<boolean>
): Promise<AnswerOutcome> {
    const row = await prisma.agentPermissionRequest.findUnique({
        where: { id: requestId },
        select: { sessionId: true, status: true }
    });
    if (!row || !(await canControl(row.sessionId))) return { ok: false, reason: "gone" };
    const moved = await prisma.agentPermissionRequest.updateMany({
        where: { id: requestId, status: "pending" },
        data: { status: choice, answeredById: userId, answeredAt: new Date() }
    });
    if (moved.count > 0) {
        touchSession(row.sessionId);
        return { ok: true, status: choice };
    }
    const now = await prisma.agentPermissionRequest.findUnique({
        where: { id: requestId },
        select: { status: true }
    });
    if (now?.status === choice) return { ok: true, status: choice };
    return { ok: false, reason: now?.status === "expired" ? "expired" : "answered" };
}
