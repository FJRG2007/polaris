/**
 * A Code session's `/goal`, the way a chat's works (`lib/polar/goals.ts`):
 * kept on the session row, judged by the person's helper model after each turn
 * the agent finishes (the `turn.end` hook, `api/agents/sessions/[id]/events`),
 * and, while not met, sent back to the agent as its next prompt through the
 * same path a typed one takes.
 *
 * A judgement is saved only over the goal and turn it judged, so a goal
 * cleared or replaced while it was judged is never brought back, and a turn
 * reported twice is judged into the goal once.
 *
 * Server-only.
 */

import { randomUUID } from "node:crypto";
import { prisma, Prisma } from "@polaris/db";
import { PLAIN_TURN } from "@/lib/polar/automatic";
import { automaticChoice } from "@/lib/polar/shared";
import { resolvePolarModel } from "@/lib/polar/models";
import { polarPreferences } from "@/lib/polar/preferences";
import { polarHelperModel } from "@/lib/polar/helper-model";
import { promptSession } from "@/lib/agents/session-runtime";
import { judgeGoalTranscript } from "@/lib/polar/goal-service";
import { addSessionMessage } from "@/lib/agents/session-service";
import { syncSessionHistorySoon } from "@/lib/agents/session-history";
import { sessionGoalTranscript, sessionTurnOutcome } from "@/lib/agents/session-goal-text";
import {
    continuationText,
    continuesAfter,
    goalAfterTurn,
    newGoal,
    readGoal,
    type GoalJudgement,
    type PolarGoal
} from "@/lib/polar/goals";

/** How many of the newest stored lines the judge reads. */
const LINES_READ = 120;

export async function sessionGoal(sessionId: string): Promise<PolarGoal | null> {
    const row = await prisma.agentSession.findUnique({ where: { id: sessionId }, select: { goal: true } });
    return readGoal(row?.goal);
}

/** Sets the session's goal, replacing any it had. Access is checked by the caller. */
export async function setSessionGoal(sessionId: string, condition: string, now = Date.now()): Promise<PolarGoal> {
    const goal = newGoal(randomUUID(), condition, now);
    await prisma.agentSession.update({
        where: { id: sessionId },
        data: { goal: goal as unknown as Prisma.InputJsonValue },
        select: { id: true }
    });
    return goal;
}

/** Removes the session's goal; the one removed, or null when there was none. */
export async function clearSessionGoal(sessionId: string): Promise<PolarGoal | null> {
    const goal = await sessionGoal(sessionId);
    if (!goal) return null;
    await prisma.agentSession.updateMany({ where: { id: sessionId }, data: { goal: Prisma.DbNull } });
    return goal;
}

/** Writes `next` only while the session still holds the goal at the turn it came from. */
async function saveJudged(sessionId: string, from: PolarGoal, next: PolarGoal): Promise<boolean> {
    const { count } = await prisma.agentSession.updateMany({
        where: {
            id: sessionId,
            AND: [
                { goal: { path: ["id"], equals: from.id } },
                { goal: { path: ["turns"], equals: from.turns } }
            ]
        },
        data: { goal: next as unknown as Prisma.InputJsonValue }
    });
    return count > 0;
}

/** The judge for this person: their helper pick, else Automatic's fastest. */
async function judge(userId: string, condition: string, transcript: string): Promise<GoalJudgement> {
    const fallback = await resolvePolarModel(userId, automaticChoice("fast"), PLAIN_TURN);
    // No model this person may use: the goal waits as unchecked.
    if (typeof fallback === "string") return null;
    const settings = await polarPreferences(userId).catch(() => null);
    const helper = await polarHelperModel(userId, fallback, settings?.helperModel ?? null);
    return judgeGoalTranscript(userId, null, condition, transcript, helper);
}

export interface SessionGoalPorts {
    judge: typeof judge;
    prompt: (sessionId: string, text: string, authorId: string) => Promise<void>;
    sync: (sessionId: string) => Promise<unknown>;
    now: () => number;
}

const PORTS: SessionGoalPorts = {
    judge,
    prompt: async (sessionId, text, authorId) => {
        await addSessionMessage(sessionId, "user", text, authorId);
        await promptSession(sessionId, text);
    },
    sync: (sessionId) => syncSessionHistorySoon(sessionId),
    now: Date.now
};

/**
 * After a turn ends: judge the goal against what the session shows, save the
 * judgement, and send the next turn while it is not met. Returns the goal as
 * saved, or null when nothing was judged. Best effort: never throws.
 */
export async function judgeSessionGoal(
    sessionId: string,
    ports: SessionGoalPorts = PORTS
): Promise<PolarGoal | null> {
    try {
        const row = await prisma.agentSession.findUnique({
            where: { id: sessionId },
            select: { goal: true, state: true, startedById: true }
        });
        const goal = readGoal(row?.goal);
        // A session with nobody behind it has no helper model to judge with.
        if (!row?.startedById || !goal || goal.status !== "active") return null;
        const owner = row.startedById;
        // The answer that ended the turn has to be stored before it is read.
        await ports.sync(sessionId).catch(() => undefined);
        const newest = await prisma.agentSessionMessage.findMany({
            where: { sessionId },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: LINES_READ,
            select: { role: true, kind: true, subject: true, body: true }
        });
        const lines = newest.reverse();
        const outcome = sessionTurnOutcome(lines, row.state === "waiting");
        // Nothing to judge (waits on a person, or was stopped): nothing changes.
        if (!goalAfterTurn(goal, outcome, null, ports.now())) return null;
        const judgement = await ports.judge(owner, goal.condition, sessionGoalTranscript(lines));
        const next = goalAfterTurn(goal, outcome, judgement, ports.now());
        if (!next || !(await saveJudged(sessionId, goal, next))) return null;
        if (continuesAfter(next)) await ports.prompt(sessionId, continuationText(next), owner);
        return next;
    } catch (error) {
        console.error(`[agent-session] ${sessionId}: could not judge the goal`, error);
        return null;
    }
}
