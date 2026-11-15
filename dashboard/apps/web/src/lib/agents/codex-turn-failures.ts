/**
 * A Codex turn that ended without a hook: read from Codex's own rollout and
 * handled as the hook would have been.
 *
 * Codex fires no hook for a turn whose model request failed, nor for an Esc
 * (`newestCodexBoundary`), so a usage limit never reached the rotation and the
 * session read "Working" for good. The end of the rollout is read instead -
 * from the history read when it already has the lines, and from a sweep for a
 * session that went quiet mid-turn - and the turn is ended there: a failure is
 * recorded as one and handed to `handleTurnFailure`, which already reads
 * Codex's wording; an Esc ends the turn.
 *
 * The sequence is the record's own time in nanoseconds, the unit the hooks
 * stamp theirs in, so an end older than the event that moved the session is
 * history, and a copy read twice is acted on once (`limitSeq`).
 *
 * Ported from Agent Orchestrator (Apache-2.0),
 * backend/internal/observe/activity/turn_failures.go (`TurnFailureObserver`:
 * only sessions in a turn, only an end newer than what put them there).
 */

import { prisma } from "@polaris/db";
import { runInSession } from "./session-runtime";
import { handleTurnFailure } from "./account-rotation";
import { recordSessionEvents } from "./session-service";
import { isSignInRefusal, noteRefusedSignIn } from "./signin-refusal";
import { readableTranscriptPath, readTranscriptTail } from "./session-transcript";
import { newestCodexBoundary, type CodexTurnBoundary } from "./transcript-decoders";

/** The states a turn is in: running, or paused on an answer it then got. */
const IN_A_TURN = ["working", "waiting"];

/** The longest failure kept on the event, as a hook's detail is: one line. */
const DETAIL_CHARS = 300;

/** Sessions one sweep reads at most. */
export const SWEEP_BATCH = 20;
/** Quiet this long before a sweep reads the rollout: a turn that is running
 *  reports a tool every few seconds. */
export const QUIET_MS = 15_000;
/** Quiet longer than this is left alone: a turn that ended hours ago with no
 *  sign is not one this read is going to explain. */
export const QUIET_MOST_MS = 6 * 60 * 60 * 1000;

/** A Codex rollout, by its name: the only file this reads. */
export function isCodexRollout(path: string | null | undefined): path is string {
    if (!readableTranscriptPath(path)) return false;
    const name = path.slice(path.lastIndexOf("/") + 1);
    return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

/** Ports, so a test can watch them. */
export interface TurnEndPorts {
    readonly failed: (sessionId: string, message: string, seq: bigint) => Promise<unknown>;
}

const PORTS: TurnEndPorts = {
    failed: async (sessionId, message, seq) => {
        if (isSignInRefusal(message)) return noteRefusedSignIn(sessionId);
        return handleTurnFailure(sessionId, { error: "", message }, seq);
    }
};

/**
 * End a Codex session's turn from the rollout's newest boundary, when that is
 * a turn that failed or was interrupted and is newer than whatever put the
 * session in its turn. Returns what it recorded. Never throws.
 */
export async function noteCodexTurnEnd(
    sessionId: string,
    boundary: CodexTurnBoundary | null,
    ports: TurnEndPorts = PORTS
): Promise<"failed" | "interrupted" | null> {
    if (!boundary || boundary.kind !== "ended" || boundary.at === null) return null;
    if (boundary.error === null && !boundary.interrupted) return null;
    try {
        const seq = BigInt(boundary.at) * 1_000_000n;
        const row = await prisma.agentSession.findUnique({
            where: { id: sessionId },
            select: { cli: true, state: true, lastEventSeq: true }
        });
        if (!row || row.cli !== "codex" || !IN_A_TURN.includes(row.state)) return null;
        if (row.lastEventSeq !== null && seq <= row.lastEventSeq) return null;
        if (boundary.error === null) {
            await recordSessionEvents(sessionId, [{ kind: "turn.end", detail: "", subject: "" }], seq);
            return "interrupted";
        }
        const detail = boundary.error.replace(/\s+/g, " ").trim().slice(0, DETAIL_CHARS);
        await recordSessionEvents(sessionId, [{ kind: "turn.failed", detail, subject: "" }], seq);
        await ports.failed(sessionId, boundary.error, seq);
        return "failed";
    } catch (error) {
        console.error(
            `[agent-session] ${sessionId}: could not end a Codex turn from its rollout:`,
            error instanceof Error ? error.message : "unknown"
        );
        return null;
    }
}

type Run = (sessionId: string, script: string) => Promise<{ code: number; output: string }>;

/**
 * Read the end of the rollout of the Codex sessions that went quiet in a turn,
 * and end the turns that failed or were interrupted. Bounded per sweep, the
 * most recently quiet first. Returns how many turns it ended.
 */
export async function sweepCodexTurnEnds(
    { run = runInSession, now = Date.now(), ports = PORTS }: { run?: Run; now?: number; ports?: TurnEndPorts } = {}
): Promise<number> {
    const rows = await prisma.agentSession.findMany({
        where: {
            cli: "codex",
            state: { in: IN_A_TURN },
            lastEventAt: { lt: new Date(now - QUIET_MS), gt: new Date(now - QUIET_MOST_MS) },
            transcriptPath: { not: null }
        },
        select: { id: true, transcriptPath: true },
        orderBy: { lastEventAt: "desc" },
        take: SWEEP_BATCH
    });
    let ended = 0;
    for (const row of rows) {
        const path = row.transcriptPath;
        if (!isCodexRollout(path)) continue;
        const read = await readTranscriptTail(
            path,
            async (script) => (await run(row.id, script)).output,
            (lines) => newestCodexBoundary(lines) !== null
        ).catch(() => null);
        if (read?.kind !== "ok") continue;
        if (await noteCodexTurnEnd(row.id, newestCodexBoundary(read.lines), ports)) ended += 1;
    }
    return ended;
}
