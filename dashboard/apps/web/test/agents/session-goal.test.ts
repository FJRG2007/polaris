/**
 * A Code session's /goal: what the judge reads, what a turn did, and how a
 * judgement is saved and continued after the turn ends.
 */

import { newGoal, type PolarGoal } from "@/lib/polar/goals";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionGoalTranscript, sessionTurnOutcome, type GoalLine } from "@/lib/agents/session-goal-text";

const SESSION = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-0000000000aa";
const NOW = Date.UTC(2026, 10, 15, 10, 0, 0);

const db = vi.hoisted(() => ({
    session: null as { goal: unknown; state: string; startedById: string } | null,
    lines: [] as { role: string; kind: string; subject: string; body: string }[]
}));

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null, InputJsonValue: null },
    prisma: {
        agentSession: {
            findUnique: async () => (db.session ? { ...db.session } : null),
            update: async ({ data }: { data: { goal: unknown } }) => {
                if (db.session) db.session.goal = data.goal;
                return { id: SESSION };
            },
            updateMany: async ({ where, data }: { where: { AND?: { goal: { path: string[]; equals: unknown } }[] }; data: { goal: unknown } }) => {
                const goal = db.session?.goal as Record<string, unknown> | null | undefined;
                if (!db.session) return { count: 0 };
                for (const clause of where.AND ?? []) {
                    if (!goal || goal[clause.goal.path[0]!] !== clause.goal.equals) return { count: 0 };
                }
                db.session.goal = data.goal;
                return { count: 1 };
            }
        },
        agentSessionMessage: { findMany: async () => [...db.lines].reverse() }
    }
}));
vi.mock("@/lib/agents/session-service", () => ({ addSessionMessage: vi.fn() }));
vi.mock("@/lib/agents/session-runtime", () => ({ promptSession: vi.fn() }));
vi.mock("@/lib/agents/session-history", () => ({ syncSessionHistorySoon: vi.fn() }));
vi.mock("@/lib/polar/models", () => ({ resolvePolarModel: vi.fn() }));
vi.mock("@/lib/polar/preferences", () => ({ polarPreferences: vi.fn() }));
vi.mock("@/lib/polar/helper-model", () => ({ polarHelperModel: vi.fn() }));
vi.mock("@/lib/polar/goal-service", () => ({ judgeGoalTranscript: vi.fn() }));
vi.mock("@/lib/polar/automatic", () => ({ PLAIN_TURN: {} }));
vi.mock("@/lib/polar/shared", () => ({ automaticChoice: () => ({}) }));

const { judgeSessionGoal, clearSessionGoal, setSessionGoal } = await import("@/lib/agents/session-goal");

const line = (role: string, kind: string, body: string, subject = ""): GoalLine => ({ role, kind, subject, body });

function ports(verdict: "met" | "not_met" | "impossible" | null) {
    return {
        judge: vi.fn(async () => (verdict ? { verdict, reason: `reason ${verdict}` } : null)),
        prompt: vi.fn(async () => undefined),
        sync: vi.fn(async () => undefined),
        now: () => NOW + 1_000
    };
}

function withGoal(goal: PolarGoal | null, state = "idle") {
    db.session = { goal, state, startedById: OWNER };
}

beforeEach(() => {
    db.session = null;
    db.lines = [line("user", "text", "make the tests pass"), line("agent", "tool", "npm test", "Bash"), line("agent", "text", "All 12 pass.")];
});

describe("what the judge reads", () => {
    it("writes who said what, with tools by name and markers in brackets", () => {
        const text = sessionGoalTranscript([
            line("user", "text", "fix it"),
            line("agent", "tool", "npm test", "Bash"),
            line("agent", "result", "ok", "Bash"),
            line("system", "marker", "", "compacted"),
            line("agent", "text", "  ")
        ]);
        expect(text).toBe("Person: fix it\nAssistant used Bash: npm test\nTool result (Bash): ok\n[compacted]");
    });

    it("clips a long line", () => {
        expect(sessionGoalTranscript([line("agent", "text", "x".repeat(5_000))]).length).toBeLessThan(1_600);
    });
});

describe("what a turn did", () => {
    it("reads only the lines after the person's last message", () => {
        const lines = [line("agent", "tool", "old", "Bash"), line("user", "text", "go"), line("agent", "text", "done")];
        expect(sessionTurnOutcome(lines, false)).toEqual({
            awaitingApproval: false,
            interrupted: false,
            usedTools: false,
            tokens: 0
        });
    });

    it("sees an interruption, a tool and a wait on the person", () => {
        const lines = [line("user", "text", "go"), line("agent", "tool", "ls", "Bash"), line("system", "marker", "", "interrupted")];
        expect(sessionTurnOutcome(lines, true)).toMatchObject({ awaitingApproval: true, interrupted: true, usedTools: true });
    });
});

describe("judging after a turn", () => {
    it("does nothing without an active goal", async () => {
        withGoal(null);
        const p = ports("met");
        expect(await judgeSessionGoal(SESSION, p)).toBeNull();
        expect(p.judge).not.toHaveBeenCalled();
    });

    it("keeps going while not met: saves the turn and sends the next prompt", async () => {
        withGoal(newGoal("g1", "tests pass", NOW));
        const p = ports("not_met");
        const next = await judgeSessionGoal(SESSION, p);
        expect(next).toMatchObject({ status: "active", verdict: "not_met", turns: 1, reason: "reason not_met" });
        expect(p.judge).toHaveBeenCalledWith(OWNER, "tests pass", expect.stringContaining("Assistant: All 12 pass."));
        expect(p.prompt).toHaveBeenCalledWith(SESSION, expect.stringContaining("Keep working toward the goal: tests pass"), OWNER);
        expect((db.session?.goal as PolarGoal).turns).toBe(1);
    });

    it("ends the goal when met, without another prompt", async () => {
        withGoal(newGoal("g1", "tests pass", NOW));
        const p = ports("met");
        expect(await judgeSessionGoal(SESSION, p)).toMatchObject({ status: "met" });
        expect(p.prompt).not.toHaveBeenCalled();
    });

    it("pauses as unchecked when the judge cannot answer", async () => {
        withGoal(newGoal("g1", "tests pass", NOW));
        const p = ports(null);
        expect(await judgeSessionGoal(SESSION, p)).toMatchObject({ status: "active", verdict: "unchecked" });
        expect(p.prompt).not.toHaveBeenCalled();
    });

    it("does not judge a turn waiting on the person", async () => {
        withGoal(newGoal("g1", "tests pass", NOW), "waiting");
        const p = ports("met");
        expect(await judgeSessionGoal(SESSION, p)).toBeNull();
        expect(p.judge).not.toHaveBeenCalled();
    });

    it("never brings back a goal replaced while it was judged", async () => {
        withGoal(newGoal("g1", "tests pass", NOW));
        const p = ports("not_met");
        p.judge.mockImplementation(async () => {
            db.session!.goal = newGoal("g2", "other", NOW);
            return { verdict: "not_met", reason: "r" };
        });
        expect(await judgeSessionGoal(SESSION, p)).toBeNull();
        expect((db.session?.goal as PolarGoal).id).toBe("g2");
        expect(p.prompt).not.toHaveBeenCalled();
    });

    it("sets and clears", async () => {
        withGoal(null);
        const goal = await setSessionGoal(SESSION, "lint is clean", NOW);
        expect(db.session?.goal).toEqual(goal);
        expect(await clearSessionGoal(SESSION)).toEqual(goal);
        expect(db.session?.goal).toBeNull();
    });
});
