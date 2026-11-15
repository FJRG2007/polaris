import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    sessionArgs: [] as Array<{ where: Record<string, unknown>; take: number }>,
    live: [] as unknown[],
    done: [] as unknown[],
    pulls: [] as unknown[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            findMany: async (args: { where: { state: { in?: string[] } }; take: number }) => {
                db.sessionArgs.push(args as never);
                return args.where.state.in ? db.done : db.live;
            }
        },
        sessionPullFacts: { findMany: async () => db.pulls },
        user: {
            findMany: async () => [{ id: "0190a1b2-c3d4-7e5f-8a9b-000000000009", name: "Ada" }]
        }
    }
}));

import * as codeBoard from "@/lib/polar/code-board";

const now = new Date("2026-11-15T12:00:00.000Z");
const person = "0190a1b2-c3d4-7e5f-8a9b-000000000009";

function session(id: string, state: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        title: `Task ${id}`,
        cli: "claude-code",
        state,
        branch: "polaris/task",
        startedById: person,
        lastEventAt: new Date("2026-11-15T11:59:00.000Z"),
        startedAt: new Date("2026-11-15T11:00:00.000Z"),
        createdAt: new Date("2026-11-15T11:00:00.000Z"),
        workState: null,
        workCommits: null,
        prUrl: null,
        repo: { repoFullName: "acme/app" },
        ...extra
    };
}

function pull(sessionId: string, extra: Record<string, unknown> = {}) {
    return {
        sessionId,
        url: "https://github.com/acme/app/pull/7",
        number: 7,
        state: "open",
        draft: false,
        mergeable: "mergeable",
        checks: "failing",
        checksTotal: 4,
        checksFailed: 1,
        checksPending: 0,
        review: "none",
        unresolvedComments: 0,
        sourceBranch: "polaris/task",
        targetBranch: "main",
        ...extra
    };
}

beforeEach(() => {
    db.sessionArgs = [];
    db.live = [];
    db.done = [];
    db.pulls = [];
});

describe("readCodeBoard", () => {
    it("puts each session in its column with its pull request and checks", async () => {
        db.live = [session("a", "waiting"), session("b", "working"), session("c", "idle")];
        db.done = [session("d", "stopped")];
        db.pulls = [pull("c")];
        const answer = await codeBoard.readCodeBoard("owner", {}, now);
        const byId = new Map(answer.cards.map((card) => [card.id, card]));
        expect(byId.get("a")?.column).toBe("needs_you");
        expect(byId.get("b")?.column).toBe("working");
        expect(byId.get("c")).toMatchObject({
            column: "fix_needed",
            status: "ci_failed",
            branch: "polaris/task",
            personName: "Ada",
            pull: { number: 7, checks: { total: 4, failed: 1, pending: 0, passed: 3 } }
        });
        expect(byId.get("d")?.column).toBe("done");
        expect(answer.truncated).toBe(false);
        expect(answer.doneNext).toBeNull();
    });

    it("bounds both reads and applies every filter inside the account's reach", async () => {
        const repo = "0190a1b2-c3d4-7e5f-8a9b-000000000001";
        await codeBoard.readCodeBoard("owner", { repo, agent: "codex", person }, now);
        expect(db.sessionArgs).toHaveLength(2);
        for (const args of db.sessionArgs) {
            expect(args.take).toBeLessThanOrEqual(codeBoard.LIVE_CAP + 1);
            expect(args.where).toMatchObject({
                OR: [{ repo: { ownerId: "owner" } }, { repoId: null, startedById: "owner" }],
                repoId: repo,
                cli: "codex",
                startedById: person
            });
        }
    });

    it("says when more sessions run than it lists, and where Done goes on", async () => {
        db.live = Array.from({ length: codeBoard.LIVE_CAP + 1 }, (_, index) =>
            session(`l${index}`, "working")
        );
        db.done = Array.from({ length: codeBoard.DONE_PAGE + 1 }, (_, index) =>
            session(`0190a1b2-c3d4-7e5f-8a9b-${String(index).padStart(12, "0")}`, "stopped")
        );
        const answer = await codeBoard.readCodeBoard("owner", {}, now);
        expect(answer.truncated).toBe(true);
        expect(answer.cards.filter((card) => card.column === "working")).toHaveLength(codeBoard.LIVE_CAP);
        expect(answer.cards.filter((card) => card.column === "done")).toHaveLength(codeBoard.DONE_PAGE);
        expect(answer.doneNext).toMatch(/^2026-11-15T11:00:00\.000Z_/);
    });

    it("reads nothing for a Done cursor that does not parse", async () => {
        expect(await codeBoard.readDonePage("owner", {}, "garbage", now)).toEqual({
            cards: [],
            doneNext: null
        });
        expect(db.sessionArgs).toHaveLength(0);
    });
});
