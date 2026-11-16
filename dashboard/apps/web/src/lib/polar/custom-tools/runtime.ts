/**
 * Custom tools and project tools running for Polar, always in the person's
 * own session sandbox.
 *
 * The sandbox is the newest live Code session the person started that takes
 * commands: its container, or their own server (`runInSession`). A session on
 * somebody's computer takes protocol frames rather than commands, so it is not
 * one; no session at all and a call answers with the step that gives it one.
 * Nothing here runs a script in this process - the command `toolCommand`
 * builds is executed by the session's machine.
 *
 * Every call is parsed against the tool's declared input before it is sent,
 * and asked about in the chat unless the person set the tool to "allow"; a
 * "deny" tool is never offered.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { tool, type FlexibleSchema, type ToolSet } from "ai";
import * as store from "@/lib/polar/custom-tools/store";
import * as shared from "@/lib/polar/custom-tools/shared";
import { runInSession } from "@/lib/agents/session-runtime";

/** The live states a session takes commands in. */
const LIVE_STATES = ["working", "waiting", "idle"];

export interface Sandbox {
    readonly sessionId: string;
    /** The repository it works in, the key an approval is kept under. */
    readonly repository: string | null;
}

/** The person's newest live session that takes commands, or null. `sessionId`
 *  narrows it to one, still only theirs. */
export async function sandboxFor(userId: string, sessionId: string | null = null): Promise<Sandbox | null> {
    const row = await prisma.agentSession.findFirst({
        where: {
            startedById: userId,
            state: { in: LIVE_STATES },
            place: { not: "computer" },
            ...(sessionId ? { id: sessionId } : {})
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, repoId: true }
    });
    return row ? { sessionId: row.id, repository: row.repoId } : null;
}

export type CallOutcome = { ok: boolean; text: string };

const NO_SANDBOX =
    "Custom tools run in one of your Code sessions, and none is running. Start a Code session, then ask again.";

/** One call of a tool, parsed and run in the sandbox. */
export async function runTool(
    sandbox: Sandbox,
    definition: shared.CustomTool,
    written: unknown,
    run: typeof runInSession = runInSession
): Promise<CallOutcome> {
    const args = shared.callSchema(definition.input).safeParse(written ?? {});
    if (!args.success) return { ok: false, text: `${definition.name} was called with input it does not take.` };
    try {
        const result = await run(sandbox.sessionId, shared.toolCommand(definition, args.data));
        const outcome = shared.readToolRun(result.output);
        if (outcome.timedOut)
            return { ok: false, text: `${definition.name} ran past ${definition.timeoutSeconds} s and was stopped.\n${outcome.text}` };
        return { ok: outcome.ok, text: outcome.text || (outcome.ok ? "(no output)" : `Exited with ${outcome.code ?? "an error"}.`) };
    } catch (error) {
        console.error(`[polar-tools] ${definition.name} could not run in ${sandbox.sessionId}`, error);
        return { ok: false, text: "The session could not run the tool. It may have just stopped." };
    }
}

/** A repository's own tools as the sandbox's checkout has them, and whether
 *  the person approved this revision of them. */
export interface ProjectReview extends shared.ProjectTools {
    readonly digest: string;
    readonly approved: boolean;
    readonly files: shared.ProjectFile[];
}

export async function reviewProjectTools(
    userId: string,
    sandbox: Sandbox,
    run: typeof runInSession = runInSession
): Promise<ProjectReview | null> {
    if (!sandbox.repository) return null;
    const result = await run(sandbox.sessionId, shared.projectFilesCommand()).catch(() => null);
    if (!result) return null;
    const files = shared.readProjectFiles(result.output);
    if (files.length === 0) return null;
    const digest = await shared.projectDigest(files);
    const approved = await store.isApproved(userId, sandbox.repository, digest);
    return { ...shared.parseProjectTools(files), digest, approved, files };
}

/** Project reviews kept a short while, so a chat turn does not read the
 *  checkout every time. A new revision shows up within the window. */
const REVIEW_TTL_MS = 30_000;
const reviews = new Map<string, { at: number; review: ProjectReview | null }>();

async function cachedReview(userId: string, sandbox: Sandbox): Promise<ProjectReview | null> {
    const key = `${userId}:${sandbox.sessionId}`;
    const hit = reviews.get(key);
    if (hit && Date.now() - hit.at < REVIEW_TTL_MS) return hit.review;
    const review = await reviewProjectTools(userId, sandbox).catch(() => null);
    if (reviews.size > 500) reviews.clear();
    reviews.set(key, { at: Date.now(), review });
    return review;
}

/** Forgets a cached review, after the person approved one. */
export function forgetReview(userId: string, sessionId: string): void {
    reviews.delete(`${userId}:${sessionId}`);
}

export interface CustomToolSet {
    tools: ToolSet;
    approval: Record<string, () => Promise<"approved" | "user-approval">>;
    described: Record<string, { title: string; writes: boolean; destructive: boolean }>;
}

/** Whether a definition is offered at all. */
export function offered(definition: Pick<shared.CustomTool, "enabled" | "permission">): boolean {
    return definition.enabled && definition.permission !== "deny";
}

/**
 * The person's custom tools, and the approved revision of their newest
 * session's repository tools, as AI SDK tools. The sandbox is found again on
 * every call: the session a turn started with may have stopped by the time an
 * approval comes back.
 */
export async function polarCustomTools(userId: string): Promise<CustomToolSet> {
    const own = (await store.listTools(userId).catch(() => [])).filter(offered);
    const sandbox = await sandboxFor(userId).catch(() => null);
    const review = sandbox ? await cachedReview(userId, sandbox) : null;
    const project = review?.approved ? review.tools.filter((entry) => !own.some((mine) => mine.name === entry.name)) : [];
    const set: CustomToolSet = { tools: {}, approval: {}, described: {} };
    for (const definition of [...own, ...project]) {
        const name = shared.turnToolName(definition.name);
        const fromProject = "path" in definition;
        set.tools[name] = tool({
            description: definition.description,
            inputSchema: shared.callSchema(definition.input) as unknown as FlexibleSchema<Record<string, unknown>>,
            async execute(written: unknown) {
                const at = await sandboxFor(userId, fromProject && sandbox ? sandbox.sessionId : null);
                if (!at) return { ok: false, text: NO_SANDBOX };
                return runTool(at, definition, written);
            }
        });
        // A repository's tool is always asked about: the approval was for the
        // files, not for every call any input could make.
        const allowed = definition.permission === "allow" && !fromProject;
        set.approval[name] = async () => (allowed ? "approved" : "user-approval");
        set.described[name] = { title: definition.name, writes: true, destructive: !allowed };
    }
    return set;
}
