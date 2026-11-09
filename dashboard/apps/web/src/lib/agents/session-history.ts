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
import {
    decodeClaudeLine,
    promptKey,
    transcriptDecoder,
    type HistoryRow,
    type TranscriptDecoder
} from "./transcript-decoders";
import { readableTranscriptPath, readTranscript } from "./session-transcript";
import { claudeLineUsage, recordSessionUsage, type TurnUsage } from "./session-usage";

/** The shortest gap between two reads of one transcript. */
export const SYNC_DEBOUNCE_MS = 3_000;

/** Rows stored per read at most; the rest wait for the next one. */
export const MAX_ROWS_PER_SYNC = 200;

/** Messages per page of history. */
export const HISTORY_PAGE = 50;

/** How far back an unlinked prompt typed in Polaris is looked for. */
const LINK_WINDOW = 50;

export type SyncOutcome = "synced" | "skipped" | "unavailable";

/** Reads one sync makes back to back while the transcript has more. */
export const MAX_READS_PER_SYNC = 4;

/** Reads the last sync of an ending session makes, so its final turn is in. */
export const MAX_READS_PER_FINAL_SYNC = 40;

type Run = (sessionId: string, script: string) => Promise<{ code: number; output: string }>;

const runEvenIfFinished: Run = (sessionId, script) =>
    runInSession(sessionId, script, { evenIfFinished: true });

/**
 * Read whatever the transcript gained since the last read.
 *
 * Never throws: a machine that did not answer is a history that catches up next
 * time, and the reason is logged here rather than shown.
 *
 * `final` is the read made as the session ends, while its machine is still
 * there: it ignores the debounce and that the session is over, and reads until
 * the transcript has nothing left, since nothing reads it after this.
 */
export async function syncSessionHistory(
    sessionId: string,
    { run, now = new Date(), final = false }: { run?: Run; now?: Date; final?: boolean } = {}
): Promise<SyncOutcome> {
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { cli: true, state: true, transcriptPath: true }
    });
    if (!row) return "skipped";
    if (!final && core.isSessionOver(row.state as core.AgentSessionState)) return "skipped";
    const path = row.transcriptPath;
    const decode = transcriptDecoder(row.cli);
    if (!decode || !readableTranscriptPath(path)) return "skipped";

    const claimed = await prisma.agentSession.updateMany({
        where: final
            ? { id: sessionId }
            : {
                  id: sessionId,
                  OR: [
                      { transcriptSyncedAt: null },
                      { transcriptSyncedAt: { lt: new Date(now.getTime() - SYNC_DEBOUNCE_MS) } }
                  ]
              },
        data: { transcriptSyncedAt: now }
    });
    if (claimed.count === 0) return "skipped";

    const execute = run ?? (final ? runEvenIfFinished : runInSession);
    const reads = final ? MAX_READS_PER_FINAL_SYNC : MAX_READS_PER_SYNC;
    try {
        for (let attempt = 0; attempt < reads; attempt++) {
            const step = await readOnce(sessionId, path, decode, execute, now);
            if (step === "missing") return attempt === 0 ? "skipped" : "synced";
            if (step === "failed") return attempt === 0 ? "unavailable" : "synced";
            if (step === "done") return "synced";
        }
        return "synced";
    } catch (error) {
        console.error(`[agent-session] ${sessionId}: could not read the transcript`, error);
        return "unavailable";
    }
}

/** One read from where the last stopped; "more" when the file goes on past it. */
async function readOnce(
    sessionId: string,
    path: string,
    decode: TranscriptDecoder,
    run: Run,
    now: Date
): Promise<"done" | "more" | "missing" | "failed"> {
    const cursor = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { transcriptFile: true, transcriptOffset: true }
    });
    if (!cursor) return "missing";
    const from = cursor.transcriptFile === path ? Number(cursor.transcriptOffset ?? 0n) : 0;
    const read = await readTranscript(path, from, async (script) => {
        const result = await run(sessionId, script);
        return result.output;
    });
    if (read.kind !== "ok") return read.kind;

    const rows: HistoryRow[] = [];
    const spent: TurnUsage[] = [];
    let next = from;
    let capped = false;
    for (const line of read.lines) {
        const decoded = decode(line.text);
        if (rows.length + decoded.length > MAX_ROWS_PER_SYNC && rows.length > 0) {
            capped = true;
            break;
        }
        rows.push(...decoded);
        const usage = decode === decodeClaudeLine ? claudeLineUsage(line.text) : null;
        if (usage) spent.push(usage);
        next = line.end;
    }
    if (!capped) next = read.next;

    await storeHistoryRows(sessionId, rows, now);
    // Moved only from where this read started: a read that lost a race to
    // another writes nothing over it.
    const moved = await prisma.agentSession.updateMany({
        where: {
            id: sessionId,
            transcriptFile: cursor.transcriptFile,
            transcriptOffset: cursor.transcriptOffset
        },
        data: { transcriptFile: path, transcriptOffset: BigInt(next) }
    });
    if (moved.count > 0)
        await recordSessionUsage(sessionId, spent).catch((error) =>
            console.error(`[agent-session] ${sessionId}: could not count usage`, error)
        );
    if (moved.count === 0 || next === from) return "done";
    return capped || read.more ? "more" : "done";
}

/** Sessions with a read already waiting for the debounce to pass. */
const trailing = new Set<string>();

/**
 * Read now, and once more after the debounce when this read was refused for
 * coming too soon after another - so the last hook of a burst, which is
 * usually the end of a turn, is never the one that goes unread.
 */
export async function syncSessionHistorySoon(
    sessionId: string,
    { run, wait = SYNC_DEBOUNCE_MS }: { run?: Run; wait?: number } = {}
): Promise<SyncOutcome> {
    const outcome = await syncSessionHistory(sessionId, { run });
    if (outcome !== "skipped" || trailing.has(sessionId)) return outcome;
    trailing.add(sessionId);
    try {
        await new Promise((resolve) => setTimeout(resolve, wait));
        return await syncSessionHistory(sessionId, { run });
    } finally {
        trailing.delete(sessionId);
    }
}

/**
 * The read made as a session ends, before its machine goes. Best effort: a
 * session is never kept from ending by its history.
 */
export async function syncFinalSessionHistory(sessionId: string, run?: Run): Promise<void> {
    await syncSessionHistory(sessionId, { run, final: true }).catch((error) => {
        console.error(
            `[agent-session] ${sessionId}: could not read the transcript at the end`,
            error
        );
    });
}

/**
 * Store decoded rows, once each.
 *
 * A prompt typed in Polaris is already a message - it was written when it was
 * sent - and comes back in the transcript as the agent saw it. That one is
 * linked to its transcript line rather than stored a second time, and takes
 * the line's time so it sorts among what the agent said around it.
 *
 * Rows are timed by when the agent wrote them, not when they were read, so a
 * read that fell behind still sorts them where they happened; within a read
 * each is at least a millisecond after the one before, so they never tie.
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
        ? (
              await prisma.agentSessionMessage.findMany({
                  where: { sessionId, role: "user", vendorId: null, authorId: { not: null } },
                  orderBy: { createdAt: "desc" },
                  take: LINK_WINDOW,
                  select: { id: true, body: true }
              })
          ).map((one) => ({ id: one.id, key: promptKey(one.body) }))
        : [];
    const insert: { row: HistoryRow; at: Date }[] = [];
    let last = Number.NEGATIVE_INFINITY;
    for (const [index, one] of fresh.entries()) {
        const at = new Date(Math.max(one.at ?? now.getTime() + index, last + 1));
        last = at.getTime();
        const key = one.role === "user" && one.kind === "text" ? promptKey(one.body) : null;
        const match = key
            ? [...typed].reverse().find((candidate) => candidate.key === key)
            : undefined;
        if (!match) {
            insert.push({ row: one, at });
            continue;
        }
        typed.splice(typed.indexOf(match), 1);
        // Linked only while it is still unlinked; a race that already stored
        // this line leaves the typed copy as it was.
        await prisma.agentSessionMessage
            .updateMany({
                where: { id: match.id, vendorId: null },
                data: { vendorId: one.vendorId, ...(one.at !== null ? { createdAt: at } : {}) }
            })
            .catch(() => undefined);
    }
    if (insert.length === 0) return 0;
    const created = await prisma.agentSessionMessage.createMany({
        data: insert.map(({ row: one, at }) => ({
            sessionId,
            role: one.role,
            kind: one.kind,
            subject: one.subject,
            ref: one.ref,
            body: one.body,
            vendorId: one.vendorId,
            createdAt: at
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
