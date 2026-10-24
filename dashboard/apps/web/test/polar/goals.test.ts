/**
 * `/goal` (`lib/polar/goals.ts`): what the command reads, and how one goal
 * moves turn by turn - on until its condition is met, stopped at its limit,
 * paused without tool use, and never judged while an approval is waiting.
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { controlCommandIn, POLAR_RESERVED_SHORTCUTS } from "@/lib/polar/shared";
import * as goals from "@/lib/polar/goals";

const NOW = 1_700_000_000_000;
const WORKED: goals.GoalTurnOutcome = {
    awaitingApproval: false,
    interrupted: false,
    usedTools: true,
    tokens: 120
};
const NOT_MET = { verdict: "not_met" as const, reason: "Two tests still fail." };

describe("reading /goal", () => {
    it("is a control command, so no command of a person's can take its name", () => {
        expect(controlCommandIn("/goal all tests pass")).toEqual({
            command: "goal",
            rest: "all tests pass"
        });
        expect(controlCommandIn("/GOAL")).toEqual({ command: "goal", rest: "" });
        expect(POLAR_RESERVED_SHORTCUTS).toContain("goal");
    });

    it("shows the goal with nothing after it", () => {
        expect(goals.parseGoalCommand("")).toEqual({ kind: "show" });
        expect(goals.parseGoalCommand("   ")).toEqual({ kind: "show" });
    });

    it.each(["clear", "stop", "off", "reset", "none", "CANCEL", " clear "])(
        "clears it on %j",
        (word) => expect(goals.parseGoalCommand(word)).toEqual({ kind: "clear" })
    );

    it("sets anything else as the condition, up to its limit", () => {
        expect(goals.parseGoalCommand(" the inbox is empty ")).toEqual({
            kind: "set",
            condition: "the inbox is empty"
        });
        expect(goals.parseGoalCommand("clear the inbox")).toEqual({
            kind: "set",
            condition: "clear the inbox"
        });
        expect(goals.parseGoalCommand("x".repeat(goals.GOAL_CONDITION_MAX))).toMatchObject({
            kind: "set"
        });
        expect(goals.parseGoalCommand("x".repeat(goals.GOAL_CONDITION_MAX + 1))).toEqual({
            kind: "too_long"
        });
    });
});

describe("a goal as stored", () => {
    it("starts active, with its turn and time limits", () => {
        const goal = goals.newGoal("g1", "ship it", NOW);
        expect(goal).toMatchObject({
            status: "active",
            turns: 0,
            maxTurns: goals.GOAL_TURNS_MAX,
            deadline: NOW + goals.GOAL_MINUTES_MAX * 60_000,
            verdict: null
        });
        expect(goals.readGoal(JSON.parse(JSON.stringify(goal)))).toEqual(goal);
    });

    it("reads a value that no longer parses as no goal", () => {
        expect(goals.readGoal(null)).toBeNull();
        expect(goals.readGoal({ id: "g1", condition: "x" })).toBeNull();
    });

    it("knows the message that set it, the turns it sent itself, and the rest", () => {
        const user = (metadata: unknown): UIMessage => ({
            id: "u",
            role: "user",
            metadata,
            parts: [{ type: "text", text: "x" }]
        });
        expect(goals.goalTurnOf(user({ goal: "set" }))).toBe("set");
        expect(goals.goalTurnOf(user({ goal: "continue" }))).toBe("continue");
        expect(goals.goalTurnOf(user({ goal: "resume" }))).toBe("resume");
        expect(goals.goalTurnOf(user({ goal: "approve" }))).toBeNull();
        expect(goals.goalTurnOf(user(undefined))).toBeNull();
        expect(goals.goalTurnOf({ ...user({ goal: "set" }), role: "assistant" })).toBeNull();
    });

    it("reads the newest judgement an answer carries", () => {
        const first = { ...goals.newGoal("g1", "x", NOW), turns: 1, verdict: "not_met" as const };
        const second = { ...first, turns: 2 };
        const answer = {
            id: "a",
            role: "assistant",
            parts: [
                { type: "text", text: "Working." },
                { type: goals.GOAL_PART, data: first },
                { type: goals.GOAL_PART, data: second }
            ]
        } as unknown as UIMessage;
        expect(goals.goalPartOf(answer)?.turns).toBe(2);
        expect(goals.goalPartOf({ ...answer, parts: [] })).toBeNull();
    });
});

describe("a goal turn by turn", () => {
    it("keeps going while the condition is not met, with the reason as guidance", () => {
        const next = goals.goalAfterTurn(
            goals.newGoal("g1", "tests pass", NOW),
            WORKED,
            NOT_MET,
            NOW + 1
        );
        expect(next).toMatchObject({
            status: "active",
            turns: 1,
            tokens: 120,
            verdict: "not_met",
            reason: "Two tests still fail."
        });
        expect(goals.continuesAfter(next!)).toBe(true);
        expect(goals.continuationText(next!)).toContain("tests pass");
        expect(goals.continuationText(next!)).toContain("Two tests still fail.");
        expect(goals.continuationText(next!)).toContain(`Turn 2 of ${goals.GOAL_TURNS_MAX}`);
    });

    it("ends once the condition is met, or judged impossible", () => {
        const goal = goals.newGoal("g1", "tests pass", NOW);
        const met = goals.goalAfterTurn(
            goal,
            WORKED,
            { verdict: "met", reason: "All 12 pass." },
            NOW
        );
        expect(met).toMatchObject({ status: "met", verdict: "met", endedAt: NOW });
        expect(goals.continuesAfter(met!)).toBe(false);
        const never = goals.goalAfterTurn(
            goal,
            WORKED,
            { verdict: "impossible", reason: "No repo." },
            NOW
        );
        expect(never).toMatchObject({ status: "impossible", reason: "No repo." });
    });

    it("loops until met, then stops", () => {
        let goal = goals.newGoal("g1", "tests pass", NOW);
        const verdicts = [NOT_MET, NOT_MET, { verdict: "met" as const, reason: "Green." }];
        let turns = 0;
        for (const verdict of verdicts) {
            goal = goals.goalAfterTurn(goal, WORKED, verdict, NOW)!;
            turns++;
            if (!goals.continuesAfter(goal)) break;
        }
        expect(turns).toBe(3);
        expect(goal.status).toBe("met");
    });

    it("stops at its turn limit", () => {
        let goal = goals.newGoal("g1", "never", NOW);
        let turns = 0;
        do {
            goal = goals.goalAfterTurn(goal, WORKED, NOT_MET, NOW)!;
            turns++;
        } while (goals.continuesAfter(goal) && turns < goals.GOAL_TURNS_MAX + 5);
        expect(turns).toBe(goals.GOAL_TURNS_MAX);
        expect(goal).toMatchObject({ status: "limit", verdict: "limit" });
        expect(goals.goalHasRoom(goal, NOW)).toBe(false);
    });

    it("stops at its time limit", () => {
        const goal = goals.newGoal("g1", "never", NOW);
        const late = goal.deadline + 1;
        expect(goals.goalHasRoom(goal, late)).toBe(false);
        expect(goals.goalAfterTurn(goal, WORKED, NOT_MET, late)).toMatchObject({ status: "limit" });
    });

    it("pauses after turns with no tool use, still set", () => {
        let goal = goals.newGoal("g1", "x", NOW);
        for (let turn = 0; turn < goals.GOAL_IDLE_MAX; turn++) {
            goal = goals.goalAfterTurn(goal, { ...WORKED, usedTools: false }, NOT_MET, NOW)!;
        }
        expect(goal).toMatchObject({
            status: "active",
            verdict: "idle",
            idle: goals.GOAL_IDLE_MAX
        });
        expect(goals.continuesAfter(goal)).toBe(false);
        expect(goals.goalHasRoom(goal, NOW)).toBe(true);
    });

    it("waits for the person when the judge cannot answer", () => {
        const goal = goals.goalAfterTurn(goals.newGoal("g1", "x", NOW), WORKED, null, NOW);
        expect(goal).toMatchObject({ status: "active", verdict: "unchecked" });
        expect(goals.continuesAfter(goal!)).toBe(false);
    });

    it("never judges a turn waiting on an approval, a stopped one, or an ended goal", () => {
        const goal = goals.newGoal("g1", "x", NOW);
        expect(
            goals.goalAfterTurn(goal, { ...WORKED, awaitingApproval: true }, NOT_MET, NOW)
        ).toBeNull();
        expect(
            goals.goalAfterTurn(goal, { ...WORKED, interrupted: true }, NOT_MET, NOW)
        ).toBeNull();
        expect(goals.goalAfterTurn({ ...goal, status: "met" }, WORKED, NOT_MET, NOW)).toBeNull();
    });
});
