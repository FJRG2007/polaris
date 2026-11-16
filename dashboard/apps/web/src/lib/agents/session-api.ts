/**
 * Agent sessions for a caller holding a key: the public session API
 * (`/api/v1/sessions`) and the MCP session tools both start, prompt and read
 * sessions through here, so neither can let through what the other refuses.
 *
 * Every refusal is a `SessionRefusal`, whose sentence is safe to hand back;
 * anything else is the caller's to log and replace.
 *
 * Server-only.
 */

import { after } from "next/server";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type * as sdk from "@polaris/sdk";
import * as queue from "@/lib/agents/session-queue";
import * as runtime from "@/lib/agents/session-runtime";
import * as sessions from "@/lib/agents/session-service";

export interface KeyCaller {
    readonly userId: string;
    /** The session the call comes from, for a key a session holds. */
    readonly sessionId?: string | null;
}

/** A session as the API answers it: what a caller acts on, nothing internal. */
export function publicSession(view: sessions.SessionView): sdk.Session {
    return {
        id: view.id,
        title: view.title,
        state: view.state,
        repo: view.repoFullName,
        branch: view.branch,
        agent: view.cli,
        detail: view.detail,
        error: view.error,
        pullRequest: view.pullRequest,
        createdAt: view.createdAt,
        finishedAt: view.finishedAt
    };
}

/**
 * Where a started session works.
 *
 * A named repository is looked up as before. With none, a session started BY a
 * session lands beside it - its repository (on a branch of its own), or the same
 * workspace directory on the same machine - which is what "start an agent on
 * the backend" means from inside a project. With neither, a workspace on the
 * person's own machine. Never the shared machine (see below).
 */
export async function startPlace(
    repoName: string,
    caller: KeyCaller
): Promise<{ repoId: string | null; place: core.AgentSessionPlace; hostId: string | null }> {
    if (repoName.length > 0) {
        const repo = await prisma.agentRepo.findFirst({
            where: { ownerId: caller.userId, repoFullName: repoName, enabled: true },
            select: { id: true }
        });
        if (!repo)
            throw new sessions.SessionRefusal(
                `${repoName} is not a repository the Agents app reaches for this key.`
            );
        return { repoId: repo.id, place: "local", hostId: null };
    }
    const parent = caller.sessionId
        ? await sessions.getSession(caller.sessionId, caller.userId)
        : null;
    if (!parent) return { repoId: null, place: "local", hostId: null };
    // Somebody's own computer is theirs to put work on, never a model's: a
    // session on one hands off to the Polaris box.
    if (parent.place === "computer") return { repoId: parent.repoId, place: "local", hostId: null };
    return {
        repoId: parent.repoId,
        place: parent.place,
        hostId: parent.place === "host" ? parent.hostId : null
    };
}

export interface StartRequest {
    readonly repo: string;
    readonly title: string;
    readonly prompt: string;
    readonly agent: string;
    readonly baseRef: string;
}

/** The prompt's first line, as a title when none was given. */
export function titleOf(request: Pick<StartRequest, "title" | "prompt">): string {
    if (request.title) return request.title;
    const first = request.prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
    return first.length > 80 ? `${first.slice(0, 79)}...` : first || "Session";
}

/**
 * Start a session for a key, through the same admission as the screen, so a
 * key cannot start past the ceilings a person is held to: over one, the
 * session queues. The prompt is delivered once the machine is up, after the
 * answer.
 */
export async function startAgentSession(
    caller: KeyCaller,
    request: StartRequest
): Promise<{ session: sessions.SessionView; queuedAt: number | null }> {
    const agent = core.agentCliIdSchema.safeParse(request.agent);
    if (!agent.success) throw new sessions.SessionRefusal(`${request.agent} is not an agent Polaris runs.`);
    const where = await startPlace(request.repo, caller);
    const admission = await queue.admitSession(
        {
            repoId: where.repoId,
            startedById: caller.userId,
            title: titleOf(request),
            cli: agent.data,
            command: null,
            // Not the key's to choose. A session started with a key runs in a
            // container, where the default already applies; letting a call ask
            // for more would be a credential widening its own permissions.
            unattended: null,
            // Whichever resolves. Choosing between somebody's subscriptions is
            // a choice a person makes on the form.
            accountId: null,
            // Whichever stored credential resolves. Asking the machine to answer
            // for itself is a choice a person makes about a machine they signed in.
            useMachineLogin: false,
            // The Polaris box, or the server the calling session already runs
            // on - which its person chose. A key never picks a server itself.
            place: where.place,
            // Never the shared machine, which holds everybody's logins.
            sharedHome: false,
            hostId: where.hostId,
            baseRef: request.baseRef,
            taskId: null,
            enigma: null
        },
        request.prompt
    );
    const { session } = admission;
    if (admission.startError)
        throw new sessions.SessionRefusal(
            sessions.readableFailure(admission.startError, `starting ${session.id}`)
        );
    // After the answer, not before it: the container is still cloning and
    // installing. The delivery waits for the agent's terminal and records what
    // happened on the session either way. A queued one gets it when it starts.
    if (admission.queuedAt === null) after(() => runtime.deliverFirstPrompt(session.id, request.prompt));
    return { session, queuedAt: admission.queuedAt };
}

/** Why a prompt cannot be sent to this session now, or null when it can. */
export function promptRefusal(session: sessions.SessionView): string | null {
    if (core.isSessionOver(session.state)) return "That session has ended.";
    if (core.isSessionQueued(session.state))
        return "That session is still waiting for a free slot. It gets its first prompt when it starts.";
    return null;
}

/** Say the next thing to a session, as typed. */
export async function promptAgentSession(
    caller: KeyCaller,
    session: sessions.SessionView,
    text: string
): Promise<void> {
    const refused = promptRefusal(session);
    if (refused) throw new sessions.SessionRefusal(refused);
    await sessions.addSessionMessage(session.id, "user", text, caller.userId);
    await runtime.promptSession(session.id, text);
}

type Part = sdk.StreamCursor["event"];

function afterPart(part: Part) {
    if (!part) return {};
    const at = new Date(part.at);
    return { OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: part.id } }] };
}

/** How many rows of each kind one read of a stream takes. */
export const STREAM_PAGE = 100;

type FrameData<T extends sdk.StreamFrame["type"]> = Extract<sdk.StreamFrame, { type: T }>["data"];

export type StreamItem =
    | { readonly type: "event"; readonly data: FrameData<"event"> }
    | { readonly type: "message"; readonly data: FrameData<"message"> };

/**
 * What a session's stream has after `cursor`, oldest first, each with the
 * cursor a reader is at once it has it. `more` says a page filled, so the
 * reader asks again before waiting. Ordered by time then id - the index both
 * tables have - so a row written in the same millisecond is never skipped.
 */
export async function streamAfter(
    sessionId: string,
    cursor: sdk.StreamCursor
): Promise<{ items: { item: StreamItem; cursor: sdk.StreamCursor }[]; more: boolean }> {
    const [events, messages] = await Promise.all([
        prisma.agentSessionEvent.findMany({
            // The main agent's own, as the session's event list shows them.
            where: { sessionId, agentId: null, ...afterPart(cursor.event) },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: STREAM_PAGE,
            select: { id: true, kind: true, detail: true, subject: true, createdAt: true }
        }),
        prisma.agentSessionMessage.findMany({
            where: { sessionId, ...afterPart(cursor.message) },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: STREAM_PAGE,
            select: { id: true, role: true, kind: true, subject: true, body: true, createdAt: true }
        })
    ]);
    // A full page of one kind ends where it ends: the other kind is only
    // interleaved up to that time, and the rest waits for the next read.
    const limit = (rows: { createdAt: Date }[]) =>
        rows.length === STREAM_PAGE ? rows[rows.length - 1]!.createdAt.getTime() : Infinity;
    const until = Math.min(limit(events), limit(messages));
    const merged = [
        ...events.map((row) => ({ at: row.createdAt.getTime(), id: row.id, item: {
            type: "event" as const,
            data: { id: row.id, kind: row.kind, detail: row.detail, subject: row.subject, at: row.createdAt.toISOString() }
        } })),
        ...messages.map((row) => ({ at: row.createdAt.getTime(), id: row.id, item: {
            type: "message" as const,
            data: {
                id: row.id,
                role: (["user", "agent", "system"] as const).find((role) => role === row.role) ?? "system",
                kind: row.kind,
                subject: row.subject,
                body: row.body,
                at: row.createdAt.toISOString()
            }
        } }))
    ]
        .filter((row) => row.at <= until)
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let at: sdk.StreamCursor = cursor;
    const items = merged.map((row) => {
        const part = { at: row.at, id: row.id };
        at = row.item.type === "event" ? { ...at, event: part } : { ...at, message: part };
        return { item: row.item as StreamItem, cursor: at };
    });
    return { items, more: until !== Infinity };
}

/** Where a session's stream ends right now: reading after it sends only what is new. */
export async function streamTail(sessionId: string): Promise<sdk.StreamCursor> {
    const [event, message] = await Promise.all([
        prisma.agentSessionEvent.findFirst({
            where: { sessionId, agentId: null },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { id: true, createdAt: true }
        }),
        prisma.agentSessionMessage.findFirst({
            where: { sessionId },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { id: true, createdAt: true }
        })
    ]);
    const part = (row: { id: string; createdAt: Date } | null) =>
        row ? { at: row.createdAt.getTime(), id: row.id } : null;
    return { event: part(event), message: part(message) };
}
