/**
 * "Something about this session changed", in this process and in every other.
 *
 * The session page holds a stream open on this and reloads what it shows when
 * it fires, instead of asking every few seconds. Frames carry nothing: the page
 * reads the session again through the same checks its first render used.
 *
 * Two paths feed it:
 *
 * - `touchSession`, called beside a write in this process, wakes this process's
 *   pages at once. The fast path, and the only one on an instance without
 *   Postgres.
 * - A trigger on the session tables (migration `agent_session_live_notify`)
 *   NOTIFYs `polaris_agent_session` with the session id on every write, from
 *   any process. The process's one listener connection (`lib/live/pg-listener`)
 *   hands it here, so a session open on a phone served by one replica and a PC
 *   served by another moves on both, and a write that forgot `touchSession`
 *   still reaches every page.
 *
 * A local write therefore arrives twice: the touch, then its own notice a few
 * milliseconds later. Notices for one session are merged over `MERGE_MS`, and
 * the stream route coalesces wakes over a longer window, so the echo folds into
 * the wake already pending instead of becoming a second refresh. A wake is only
 * ever "read again", so one too many is a wasted read and never a wrong screen.
 *
 * When the listener connection comes back after a gap, the sessions open here
 * that changed since it was last alive are woken, so nothing written while the
 * connection was down is missed.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { EventEmitter } from "node:events";
import * as live from "@/lib/live/pg-listener";

/** The channel the session tables' trigger notifies. */
export const SESSION_CHANNEL = "polaris_agent_session";

/** How long notices for one session are gathered into one wake. */
export const MERGE_MS = 50;

/** How many sessions one catch-up query names. */
const RESYNC_CHUNK = 500;

const NOTICE = z.object({
    s: z.string().uuid(),
    k: z.enum(["session", "event", "message", "permission"])
});

const hub = new EventEmitter();
// One listener per open session page; the default ceiling of ten is a warning
// about a leak this is not.
hub.setMaxListeners(0);

/** Sessions with a notice waiting out its merge window. */
const merging = new Map<string, ReturnType<typeof setTimeout>>();

let listening = false;

/** Tell every open page of this session, in this process, to read it again. */
export function touchSession(sessionId: string): void {
    hub.emit(sessionId);
}

/** Be told when the session changes, wherever it was changed. Returns the
 *  unsubscribe. */
export function subscribeSession(sessionId: string, listener: () => void): () => void {
    listenAcrossProcesses();
    hub.on(sessionId, listener);
    return () => {
        hub.off(sessionId, listener);
    };
}

function listenAcrossProcesses(): void {
    if (listening) return;
    listening = true;
    try {
        live.pgListener().listen(SESSION_CHANNEL, { onNotice: receiveNotice, onResync: catchUp });
    } catch (caught) {
        // The in-process path keeps working; the page's slow poll covers the rest.
        console.error("[agent-session] cross-process updates are off:", caught);
    }
}

/** A notice from the trigger: wake this session's pages here, once per window. */
export function receiveNotice(payload: string): void {
    let parsed: unknown;
    try {
        parsed = JSON.parse(payload);
    } catch {
        return;
    }
    const notice = NOTICE.safeParse(parsed);
    if (!notice.success) return;
    const sessionId = notice.data.s;
    if (hub.listenerCount(sessionId) === 0 || merging.has(sessionId)) return;
    const timer = setTimeout(() => {
        merging.delete(sessionId);
        hub.emit(sessionId);
    }, MERGE_MS);
    timer.unref?.();
    merging.set(sessionId, timer);
}

/** The ids of the sessions some page in this process is watching. */
function watched(): string[] {
    const ids: string[] = [];
    for (const name of hub.eventNames()) {
        if (typeof name !== "string" || hub.listenerCount(name) === 0) continue;
        if (NOTICE.shape.s.safeParse(name).success) ids.push(name);
    }
    return ids;
}

/**
 * After the listener was away: wake every watched session that changed since
 * `since`. Each table is asked once per chunk, grouped in the database, so a
 * session with thousands of new events is one row back.
 */
export async function catchUp(since: Date): Promise<void> {
    const ids = watched();
    for (let start = 0; start < ids.length; start += RESYNC_CHUNK) {
        const chunk = ids.slice(start, start + RESYNC_CHUNK);
        const [sessions, events, messages, asks] = await Promise.all([
            prisma.agentSession.findMany({
                where: { id: { in: chunk } },
                select: { id: true, updatedAt: true }
            }),
            prisma.agentSessionEvent.groupBy({
                by: ["sessionId"],
                where: { sessionId: { in: chunk }, createdAt: { gte: since } }
            }),
            prisma.agentSessionMessage.groupBy({
                by: ["sessionId"],
                where: { sessionId: { in: chunk }, createdAt: { gte: since } }
            }),
            prisma.agentPermissionRequest.groupBy({
                by: ["sessionId"],
                where: {
                    sessionId: { in: chunk },
                    OR: [{ createdAt: { gte: since } }, { answeredAt: { gte: since } }]
                }
            })
        ]);
        const changed = new Set<string>([
            ...sessions.filter((row) => row.updatedAt >= since).map((row) => row.id),
            ...events.map((row) => row.sessionId),
            ...messages.map((row) => row.sessionId),
            ...asks.map((row) => row.sessionId)
        ]);
        // A session deleted while away has no row left: wake it too, so its
        // page reads the absence.
        const present = new Set(sessions.map((row) => row.id));
        for (const id of chunk) if (!present.has(id)) changed.add(id);
        for (const id of changed) hub.emit(id);
    }
}
