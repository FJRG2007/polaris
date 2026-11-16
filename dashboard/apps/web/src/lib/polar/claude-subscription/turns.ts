/**
 * "Claude (your subscription)" in Polar Chat: a turn run by the managed Claude
 * Code on the person's own computer, through their runner, the way OpenCode's
 * Claude Agent provider runs it (`plugin/provider/claude-agent`).
 *
 * The provider layer (`model.ts`) hands a turn here; it goes to the runner as
 * `chat.turn` and comes back as `chat.event` frames, which
 * `computer-inbound.ts` delivers to `deliverChatEvent`. Only a runner that
 * announced `claude-chat` is ever sent one, and an event is only accepted from
 * the runner the turn was sent to, so a runner can never write into somebody
 * else's chat.
 *
 * Offered only while such a runner is online (`subscriptionRunnerFor`), with
 * the note that Anthropic does not officially support subscriptions in other
 * apps (`polar.claudeSubscription.note`).
 *
 * The registry is per process. An event that reaches a node with no such turn
 * is published on the runner bus (`computer-bus.ts`) and the node holding the
 * turn delivers it; a turn starts listening when it starts.
 *
 * An approval ends the stream it arrived on: the screen answers it and sends
 * the turn again, which resumes the same runner turn (`resume`) from where it
 * stopped. The waiting turn stays parked here for `TURN_IDLE_MS`; a resume on
 * another node picks it up from the position the approval carried.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { isOnline } from "@/lib/computers/computer-service";
import { sendToRunner } from "@/lib/computers/computer-commands";
import { onRunnerLive, publishRunnerLive, type LiveNotice } from "@/lib/computers/computer-bus";

export const CLAUDE_SUBSCRIPTION_PROVIDER = "claude-subscription";
/** Silence after which a turn is given up on. */
export const TURN_IDLE_MS = 120_000;
/** Most events held for a turn that arrived ahead of a gap. */
const EARLY_MOST = 2000;

interface Turn {
    readonly runnerId: string;
    readonly userId: string;
    nextSeq: number;
    readonly early: Map<number, core.RunnerChatEvent>;
    readonly queue: core.RunnerChatEvent[];
    wake: (() => void) | null;
    /** Set while the turn waits on an approval with no stream reading it. */
    parked: ReturnType<typeof setTimeout> | null;
    /** The sequence number of the first event not yet handed to a stream. */
    resumeSeq: number;
}

const turns = new Map<string, Turn>();

type ChatFrame = { turnId: string; seq: number; event: core.RunnerChatEvent };

/** The person's online computer that can run a subscription turn, if any. */
export async function subscriptionRunnerFor(userId: string, now = Date.now()): Promise<string | null> {
    const rows = await prisma.agentRunner.findMany({
        where: { userId, relayNode: { not: null } },
        select: { id: true, relayNode: true, lastSeenAt: true, capabilities: true },
        orderBy: { lastSeenAt: "desc" },
        take: 20
    });
    const ready = rows.find(
        (row) => isOnline(row, now) && core.runnerHasFeature(row.capabilities as { features?: string[] } | null, "claude-chat")
    );
    return ready?.id ?? null;
}

function deliverLocal(runnerId: string, frame: ChatFrame): boolean {
    const turn = turns.get(frame.turnId);
    if (!turn || turn.runnerId !== runnerId || frame.seq < turn.nextSeq) return false;
    if (turn.early.size >= EARLY_MOST && !turn.early.has(frame.seq)) return false;
    turn.early.set(frame.seq, frame.event);
    for (let event = turn.early.get(turn.nextSeq); event; event = turn.early.get(turn.nextSeq)) {
        turn.early.delete(turn.nextSeq);
        turn.nextSeq += 1;
        turn.queue.push(event);
        turn.wake?.();
    }
    return true;
}

function receiveLive(notice: LiveNotice): void {
    if (notice.k === "chat") deliverLocal(notice.runnerId, notice.frame);
}

/** A runner's `chat.event`, put in order and handed to its turn. Dropped when
 *  the turn belongs to another runner or is past it; a turn this node does not
 *  hold is handed to the other nodes. */
export function deliverChatEvent(runnerId: string, frame: ChatFrame): boolean {
    if (deliverLocal(runnerId, frame)) return true;
    if (!turns.has(frame.turnId)) void publishRunnerLive({ k: "chat", runnerId, frame });
    return false;
}

/** Where a turn's stream stopped, for the approval that carries it to the
 *  next request. Null for a turn this node does not hold. */
export function resumePoint(turnId: string): number | null {
    return turns.get(turnId)?.resumeSeq ?? null;
}

export interface SubscriptionTurnInput {
    readonly userId: string;
    readonly runnerId: string;
    readonly turnId: string;
    readonly model: string | null;
    readonly system: string;
    readonly messages: { role: "user" | "assistant"; text: string }[];
    readonly effort: core.AgentEffortLevel | null;
    readonly mcp: { url: string; token: string } | null;
    readonly signal?: AbortSignal;
    /** Carry on a turn that stopped at an approval instead of starting one:
     *  the position it stopped at and the person's answers. */
    readonly resume?: { readonly seq: number; readonly answers: readonly { approvalId: string; allow: boolean }[] };
}

function park(turnId: string, turn: Turn): void {
    if (turn.parked) clearTimeout(turn.parked);
    turn.parked = setTimeout(() => {
        if (turns.get(turnId) !== turn) return;
        turns.delete(turnId);
        void sendToRunner(turn.runnerId, { type: "chat.cancel", turnId });
    }, TURN_IDLE_MS);
    turn.parked.unref?.();
}

/**
 * Run one turn and yield its events in order, ending after `finish` or
 * `error`, or after an `approval`, which parks the turn for its answer. A turn
 * the runner never answers ends in `error: failed` after `TURN_IDLE_MS`; an
 * aborted one is cancelled on the runner too.
 */
export async function* runSubscriptionTurn(input: SubscriptionTurnInput): AsyncGenerator<core.RunnerChatEvent> {
    onRunnerLive(receiveLive);
    const held = turns.get(input.turnId);
    const adopted = input.resume && held && held.userId === input.userId && held.runnerId === input.runnerId ? held : null;
    if (adopted?.parked) clearTimeout(adopted.parked);
    const start = input.resume?.seq ?? 0;
    const turn: Turn = adopted ?? {
        runnerId: input.runnerId,
        userId: input.userId,
        nextSeq: start,
        early: new Map(),
        queue: [],
        wake: null,
        parked: null,
        resumeSeq: start
    };
    turn.parked = null;
    turns.set(input.turnId, turn);
    let parked = false;
    const onAbort = () => void sendToRunner(input.runnerId, { type: "chat.cancel", turnId: input.turnId });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        let sent = true;
        if (input.resume) {
            for (const answer of input.resume.answers) {
                const delivered = await sendToRunner(input.runnerId, {
                    type: "chat.approval",
                    turnId: input.turnId,
                    approvalId: answer.approvalId,
                    allow: answer.allow
                });
                sent = sent && delivered;
            }
        } else {
            sent = await sendToRunner(input.runnerId, {
                type: "chat.turn",
                turnId: input.turnId,
                model: input.model,
                system: input.system,
                messages: input.messages,
                effort: input.effort,
                mcp: input.mcp
            });
        }
        if (!sent) {
            yield { kind: "error", code: "failed" };
            return;
        }
        while (!input.signal?.aborted) {
            if (turn.queue.length === 0) {
                const idle = await new Promise<boolean>((resolve) => {
                    const timer = setTimeout(() => resolve(true), TURN_IDLE_MS);
                    turn.wake = () => {
                        clearTimeout(timer);
                        resolve(false);
                    };
                    input.signal?.addEventListener("abort", () => turn.wake?.(), { once: true });
                });
                turn.wake = null;
                if (idle) {
                    yield { kind: "error", code: "failed" };
                    return;
                }
                continue;
            }
            const event = turn.queue.shift()!;
            turn.resumeSeq += 1;
            if (event.kind === "approval") {
                parked = true;
                park(input.turnId, turn);
            }
            yield event;
            if (event.kind === "finish" || event.kind === "error" || event.kind === "approval") return;
        }
    } finally {
        input.signal?.removeEventListener("abort", onAbort);
        if (!parked && turns.get(input.turnId) === turn) turns.delete(input.turnId);
    }
}
