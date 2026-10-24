/**
 * `/goal`: a finish condition Polar keeps working toward across turns, the way
 * Claude Code's /goal does (https://code.claude.com/docs/en/goal). After each
 * turn a model that does not do the work judges the condition against what
 * the conversation shows: not met yet starts another turn with its reason as
 * guidance, met or impossible ends the goal. One goal per chat; a new one
 * replaces it. `/goal` alone shows it, `/goal clear` (or stop, off, reset,
 * none, cancel) removes it.
 *
 * Where Polaris differs: the turn and time limits are enforced by the server
 * and shown, instead of living in the condition's own words, and a run of
 * turns with no tool use pauses the goal rather than clearing it, as Claude
 * Code does. A goal never approves anything: a turn waiting on an approval is
 * not judged, and the next one waits for the person.
 *
 * Shared by the screen and the server: no server-only imports here.
 */

import { z } from "zod";
import type { UIMessage } from "ai";

/** Longest condition, as Claude Code allows. */
export const GOAL_CONDITION_MAX = 4000;
/** Most turns one goal may take, the first one included. */
export const GOAL_TURNS_MAX = 20;
/** Longest one goal may run, from when it was set. */
export const GOAL_MINUTES_MAX = 60;
/** Turns in a row with no tool use before the goal waits for the person. */
export const GOAL_IDLE_MAX = 3;
/** Longest reason kept from the judge. */
export const GOAL_REASON_MAX = 400;

/** The answer part each judgement is written into. */
export const GOAL_PART = "data-polar-goal";

/** Words after `/goal` that clear it rather than set a goal by that name. */
export const GOAL_CLEAR_WORDS = ["clear", "stop", "off", "reset", "none", "cancel"] as const;

/**
 * How the newest judgement went. `not_met` is the only one that starts the
 * next turn; `idle` (no tool use for a while) and `unchecked` (the judge could
 * not answer) leave the goal set and wait for the person.
 */
export const GOAL_VERDICTS = [
    "not_met",
    "met",
    "impossible",
    "limit",
    "idle",
    "unchecked"
] as const;
export type GoalVerdict = (typeof GOAL_VERDICTS)[number];

/** `active` until the goal is met, judged impossible, or out of turns or time. */
export const GOAL_STATUSES = ["active", "met", "impossible", "limit"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const polarGoalSchema = z.object({
    id: z.string().min(1).max(64),
    condition: z.string().min(1).max(GOAL_CONDITION_MAX),
    status: z.enum(GOAL_STATUSES),
    /** Turns judged so far. */
    turns: z.number().int().min(0),
    maxTurns: z.number().int().min(1),
    /** Turns in a row that used no tool. */
    idle: z.number().int().min(0),
    tokens: z.number().int().min(0),
    startedAt: z.number().int().min(0),
    /** When the time limit runs out, as epoch milliseconds. */
    deadline: z.number().int().min(0),
    /** When it stopped being active; null while it is. */
    endedAt: z.number().int().min(0).nullable(),
    verdict: z.enum(GOAL_VERDICTS).nullable(),
    reason: z.string().max(GOAL_REASON_MAX).nullable()
});
export type PolarGoal = z.infer<typeof polarGoalSchema>;

/** The stored goal, or null for none or a value that no longer parses. */
export function readGoal(value: unknown): PolarGoal | null {
    const parsed = polarGoalSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** A goal just set. */
export function newGoal(id: string, condition: string, now: number): PolarGoal {
    return {
        id,
        condition,
        status: "active",
        turns: 0,
        maxTurns: GOAL_TURNS_MAX,
        idle: 0,
        tokens: 0,
        startedAt: now,
        deadline: now + GOAL_MINUTES_MAX * 60_000,
        endedAt: null,
        verdict: null,
        reason: null
    };
}

/** What `/goal` was asked to do. */
export type GoalCommand =
    | { kind: "show" }
    | { kind: "clear" }
    | { kind: "set"; condition: string }
    | { kind: "too_long" };

/** Reads what follows `/goal`. */
export function parseGoalCommand(rest: string): GoalCommand {
    const condition = rest.trim();
    if (!condition) return { kind: "show" };
    if ((GOAL_CLEAR_WORDS as readonly string[]).includes(condition.toLowerCase())) {
        return { kind: "clear" };
    }
    if (condition.length > GOAL_CONDITION_MAX) return { kind: "too_long" };
    return { kind: "set", condition };
}

/**
 * Why a message was sent, on a goal: the one that set it (its text is the
 * condition and the first directive), one the goal sent itself after a
 * not-met judgement, or one the person sent with Continue on a paused goal.
 */
export const GOAL_TURNS = ["set", "continue", "resume"] as const;
export type GoalTurn = (typeof GOAL_TURNS)[number];
const goalTurnSchema = z.object({ goal: z.enum(GOAL_TURNS) });

export function goalTurnOf(message: UIMessage | undefined): GoalTurn | null {
    if (message?.role !== "user") return null;
    const parsed = goalTurnSchema.safeParse(message.metadata);
    return parsed.success ? parsed.data.goal : null;
}

/** The judgement an answer carries, the newest when it has more than one. */
export function goalPartOf(message: UIMessage | undefined): PolarGoal | null {
    const part = [...(message?.parts ?? [])].reverse().find((entry) => entry.type === GOAL_PART);
    return part && "data" in part ? readGoal(part.data) : null;
}

/** Whether this judgement starts the next turn on its own. */
export function continuesAfter(goal: PolarGoal): boolean {
    return goal.status === "active" && goal.verdict === "not_met";
}

/** Whether a goal may take another turn now: active, with turns and time left. */
export function goalHasRoom(goal: PolarGoal, now: number): boolean {
    return goal.status === "active" && goal.turns < goal.maxTurns && now < goal.deadline;
}

/** The message a goal sends itself to keep going. */
export function continuationText(goal: PolarGoal): string {
    return [
        `Keep working toward the goal: ${goal.condition}`,
        goal.reason ? `Not met yet: ${goal.reason}` : null,
        `Turn ${goal.turns + 1} of ${goal.maxTurns}. Show the evidence that the condition holds once it does.`
    ]
        .filter(Boolean)
        .join("\n\n");
}

/** What one finished turn showed, as the judge and the counters need it. */
export interface GoalTurnOutcome {
    /** A tool call is waiting for the person's approval. */
    awaitingApproval: boolean;
    /** The turn failed or was stopped before it finished. */
    interrupted: boolean;
    usedTools: boolean;
    tokens: number;
}

/** The judge's answer for one turn; null when it could not give one. */
export type GoalJudgement = { verdict: "met" | "not_met" | "impossible"; reason: string } | null;

/**
 * The goal after a turn: null when the turn is not judged (it waits on an
 * approval or did not finish), so nothing changes and nothing continues.
 */
export function goalAfterTurn(
    goal: PolarGoal,
    outcome: GoalTurnOutcome,
    judgement: GoalJudgement,
    now: number
): PolarGoal | null {
    if (goal.status !== "active" || outcome.awaitingApproval || outcome.interrupted) return null;
    const counted = {
        ...goal,
        turns: goal.turns + 1,
        idle: outcome.usedTools ? 0 : goal.idle + 1,
        tokens: goal.tokens + Math.max(0, Math.round(outcome.tokens))
    };
    const end = (
        status: Exclude<GoalStatus, "active">,
        verdict: GoalVerdict,
        reason: string | null
    ) => ({
        ...counted,
        status,
        verdict,
        reason,
        endedAt: now
    });
    if (judgement?.verdict === "met") return end("met", "met", judgement.reason);
    if (judgement?.verdict === "impossible")
        return end("impossible", "impossible", judgement.reason);
    const reason = judgement?.reason ?? null;
    if (counted.turns >= counted.maxTurns || now >= counted.deadline) {
        return end("limit", "limit", reason);
    }
    if (!judgement) return { ...counted, verdict: "unchecked", reason: null };
    if (counted.idle >= GOAL_IDLE_MAX) return { ...counted, verdict: "idle", reason };
    return { ...counted, verdict: "not_met", reason };
}
