/**
 * A session's conversation, read from the agent's own transcript.
 *
 * The hooks say a tool ran; the transcript is what was asked and what came back,
 * including every prompt typed straight into the terminal. It is read on the
 * agent's machine from where the last read stopped, decoded, and stored keyed by
 * the line's own id, so reading the same lines twice - two viewers polling at
 * once, a file read again from the start - stores nothing twice.
 *
 * A read is claimed on the session row before it starts, so a burst of hooks
 * and pollers is one read every few seconds rather than one per caller.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { runInSession } from "./session-runtime";
import { transcriptDecoder, type HistoryRow } from "./transcript-decoders";
import { readableTranscriptPath, readTranscript } from "./session-transcript";

/** The shortest gap between two reads of one transcript. */
export const SYNC_DEBOUNCE_MS = 3_000;

/** Rows stored per read at most; the rest wait for the next one. */
export const MAX_ROWS_PER_SYNC = 200;

/** Messages per page of history. */
export const HISTORY_PAGE = 50;

/** How far back an unlinked prompt typed in Polaris is looked for. */
const LINK_WINDOW = 50;

export type SyncOutcome = "synced" | "skipped" | "unavailable";

type Run = (sessionId: string, script: string) => Promise<{ code: number; output: string }>;

/**
 * Read whatever the transcript gained since the last read.
 *
 * Never throws: a machine that did not answer is a history that catches up next
 * time, and the reason is logged here rather than shown.
 */
export async function syncSessionHistory(
    sessionId: string,
    { run = runInSession, now = new Date() }: { run?: Run; now?: Date } = {}
): Promise<SyncOutcome> {
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: {
            cli: true,
            state: true,
            transcriptPath: true,
            transcriptFile: true,
            transcriptOffset: true
        }
    });
    if (!row || core.isSessionOver(row.state as core.AgentSessionState)) return "skipped";
    const path = row.transcriptPath;
    const decode = transcriptDecoder(row.cli);
    if (!decode || !readableTranscriptPath(path)) return "skipped";

    const claimed = await prisma.agentSession.updateMany({
        where: {
            id: sessionId,
            OR: [
                { transcriptSyncedAt: null },
                { transcriptSyncedAt: { lt: new Date(now.getTime() - SYNC_DEBOUNCE_MS) } }
            ]
        },
        data: { transcriptSyncedAt: now }
    });
    if (claimed.count === 0) return "skipped";

    const from = row.transcriptFile === path ? Number(row.transcriptOffset ?? 0n) : 0;
    try {
        const read = await readTranscript(path, from, async (script) => {
            const result = await run(sessionId, script);
            return result.output;
        });
        if (read.kind !== "ok") return read.kind === "missing" ? "skipped" : "unavailable";

        const rows: HistoryRow[] = [];
        let next = from;
        for (const line of read.lines) {
            const decoded = decode(line.text);
            if (rows.length + decoded.length > MAX_ROWS_PER_SYNC && rows.length > 0) break;
            rows.push(...decoded);
            next = line.end;
        }
        if (read.lines.length === 0 || next === read.lines.at(-1)!.end) next = read.next;

        await storeHistoryRows(sessionId, rows, now);
        // Moved only from where this read started: a read that lost a race to
        // another writes nothing over it.
        await prisma.agentSession.updateMany({
            where: {
                id: sessionId,
                transcriptFile: row.transcriptFile,
                transcriptOffset: row.transcriptOffset
            },
            data: { transcriptFile: path, transcriptOffset: BigInt(next) }
        });
        return "synced";
    } catch (error) {
        console.error(`[agent-session] ${sessionId}: could not read the transcript`, error);
        return "unavailable";
    }
}

/**
 * Store decoded rows, once each.
 *
 * A prompt typed in Polaris is already a message - it was written when it was
 * sent - and comes back in the transcript as the agent saw it. That one is
 * linked to its transcript line rather than stored a second time.
 */
export async function storeHistoryRows(
    sessionId: string,
    rows: readonly HistoryRow[],
    now: Date = new Date()
): Promise<number> {
    if (rows.length === 0) return 0;
    const known = await prisma.agentSessionMessage.findMany({
        where: { sessionId, vendorId: { in: rows.map((one) => one.vendorId) } },
        select: { vendorId: true }
    });
    const seen = new Set(known.map((one) => one.vendorId));
    const fresh = rows.filter((one) => !seen.has(one.vendorId));
    if (fresh.length === 0) return 0;

    const typed = fresh.some((one) => one.role === "user")
        ? await prisma.agentSessionMessage.findMany({
              where: { sessionId, role: "user", vendorId: null, authorId: { not: null } },
              orderBy: { createdAt: "desc" },
              take: LINK_WINDOW,
              select: { id: true, body: true }
          })
        : [];
    const insert: HistoryRow[] = [];
    for (const one of fresh) {
        const match =
            one.role === "user" && one.kind === "text"
                ? [...typed].reverse().find((candidate) => candidate.body.trim() === one.body.trim())
                : undefined;
        if (!match) {
            insert.push(one);
            continue;
        }
        typed.splice(typed.indexOf(match), 1);
        // Linked only while it is still unlinked; a race that already stored
        // this line leaves the typed copy as it was.
        await prisma.agentSessionMessage
            .updateMany({ where: { id: match.id, vendorId: null }, data: { vendorId: one.vendorId } })
            .catch(() => undefined);
    }
    if (insert.length === 0) return 0;
    // One millisecond apart, so the order they were read in is the order they
    // sort in - a batch written at one instant would otherwise tie.
    const base = now.getTime();
    const created = await prisma.agentSessionMessage.createMany({
        data: insert.map((one, index) => ({
            sessionId,
            role: one.role,
            kind: one.kind,
            subject: one.subject,
            ref: one.ref,
            body: one.body,
            vendorId: one.vendorId,
            createdAt: new Date(base + index)
        })),
        skipDuplicates: true
    });
    return created.count;
}

export interface HistoryMessage {
    id: string;
    role: string;
    kind: string;
    subject: string;
    ref: string;
    body: string;
    authorId: string | null;
    at: string;
}

/** A page of history, oldest first, ending just before `before` when given. */
export async function historyPage(
    sessionId: string,
    { before, limit = HISTORY_PAGE }: { before?: string; limit?: number } = {}
): Promise<{ messages: HistoryMessage[]; older: boolean }> {
    let where: object = { sessionId };
    if (before) {
        const anchor = await prisma.agentSessionMessage.findFirst({
            where: { id: before, sessionId },
            select: { id: true, createdAt: true }
        });
        if (!anchor) return { messages: [], older: false };
        where = {
            sessionId,
            OR: [
                { createdAt: { lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, id: { lt: anchor.id } }
            ]
        };
    }
    const records = await prisma.agentSessionMessage.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: {
            id: true,
            role: true,
            kind: true,
            subject: true,
            ref: true,
            body: true,
            authorId: true,
            createdAt: true
        }
    });
    const older = records.length > limit;
    return {
        older,
        messages: records
            .slice(0, limit)
            .map(({ createdAt, ...rest }) => ({ ...rest, at: createdAt.toISOString() }))
            .reverse()
    };
}
