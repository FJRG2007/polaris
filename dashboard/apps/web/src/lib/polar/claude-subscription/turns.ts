/**
 * "Claude (your subscription)" in Polar Chat: a turn run by the managed Claude
 * Code on the person's own computer, through their runner, the way OpenCode's
 * Claude Agent provider runs it (`plugin/provider/claude-agent`).
 *
 * The provider layer hands a turn here; it goes to the runner as `chat.turn`
 * and comes back as `chat.event` frames, which `computer-inbound.ts` delivers
 * to `deliverChatEvent`. Only a runner that announced `claude-chat` is ever
 * sent one, and an event is only accepted from the runner the turn was sent
 * to, so a runner can never write into somebody else's chat.
 *
 * Offered only while such a runner is online (`subscriptionRunnerFor`), with
 * the note that Anthropic does not officially support subscriptions in other
 * apps (`polar.claudeSubscription.note`).
 *
 * enigma: the turn registry is per process. A chat request and the runner's
 * socket on two different nodes need the `pg_notify` hop the terminal output
 * already uses (`computer-commands.ts`); see TOOLCHAIN-PLAN.md.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { isOnline } from "@/lib/computers/computer-service";
import { sendToRunner } from "@/lib/computers/computer-commands";

export const CLAUDE_SUBSCRIPTION_PROVIDER = "claude-subscription";
/** Silence after which a turn is given up on. */
export const TURN_IDLE_MS = 120_000;

interface Turn {
    readonly runnerId: string;
    readonly userId: string;
    nextSeq: number;
    readonly early: Map<number, core.RunnerChatEvent>;
    push: (event: core.RunnerChatEvent) => void;
}

const turns = new Map<string, Turn>();

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

/** A runner's `chat.event`, put in order and handed to its turn. Dropped when
 *  the turn is unknown, finished, or belongs to another runner. */
export function deliverChatEvent(runnerId: string, frame: { turnId: string; seq: number; event: core.RunnerChatEvent }): boolean {
    const turn = turns.get(frame.turnId);
    if (!turn || turn.runnerId !== runnerId || frame.seq < turn.nextSeq) return false;
    turn.early.set(frame.seq, frame.event);
    for (let event = turn.early.get(turn.nextSeq); event; event = turn.early.get(turn.nextSeq)) {
        turn.early.delete(turn.nextSeq);
        turn.nextSeq += 1;
        turn.push(event);
    }
    return true;
}

/** The person's answer to an `approval` event of their own turn. */
export async function answerApproval(userId: string, turnId: string, approvalId: string, allow: boolean): Promise<boolean> {
    const turn = turns.get(turnId);
    if (!turn || turn.userId !== userId) return false;
    return sendToRunner(turn.runnerId, { type: "chat.approval", turnId, approvalId, allow });
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
}

/**
 * Run one turn and yield its events in order, ending after `finish` or
 * `error`. A turn the runner never answers ends in `error: failed` after
 * `TURN_IDLE_MS`; an aborted one is cancelled on the runner too.
 */
export async function* runSubscriptionTurn(input: SubscriptionTurnInput): AsyncGenerator<core.RunnerChatEvent> {
    const queue: core.RunnerChatEvent[] = [];
    let wake: (() => void) | null = null;
    const turn: Turn = {
        runnerId: input.runnerId,
        userId: input.userId,
        nextSeq: 0,
        early: new Map(),
        push: (event) => {
            queue.push(event);
            wake?.();
        }
    };
    turns.set(input.turnId, turn);
    const onAbort = () => void sendToRunner(input.runnerId, { type: "chat.cancel", turnId: input.turnId });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        const sent = await sendToRunner(input.runnerId, {
            type: "chat.turn",
            turnId: input.turnId,
            model: input.model,
            system: input.system,
            messages: input.messages,
            effort: input.effort,
            mcp: input.mcp
        });
        if (!sent) {
            yield { kind: "error", code: "failed" };
            return;
        }
        while (!input.signal?.aborted) {
            if (queue.length === 0) {
                const idle = await new Promise<boolean>((resolve) => {
                    const timer = setTimeout(() => resolve(true), TURN_IDLE_MS);
                    wake = () => {
                        clearTimeout(timer);
                        resolve(false);
                    };
                    input.signal?.addEventListener("abort", () => wake?.(), { once: true });
                });
                wake = null;
                if (idle) {
                    yield { kind: "error", code: "failed" };
                    return;
                }
                continue;
            }
            const event = queue.shift()!;
            yield event;
            if (event.kind === "finish" || event.kind === "error") return;
        }
    } finally {
        input.signal?.removeEventListener("abort", onAbort);
        turns.delete(input.turnId);
    }
}
