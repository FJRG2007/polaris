/**
 * Whether a run may start.
 *
 * The property that matters is that every rule which applies has to pass, so the
 * most restrictive wins without anything having to rank them. The second is that
 * a rule on a role counts the one person it is being applied to, not the role as
 * a shared pot - the alternative would let one person's Monday stop everybody
 * else's Tuesday, with nothing on screen to see it coming.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    rules: [] as Array<{ subjectType: string; subjectId: string; metric: string; period: string; amount: number }>,
    roles: [] as Array<{ roleId: string }>,
    groups: [] as Array<{ groupId: string }>,
    /** Counted per `where` the caller built, so a test can assert what was scoped. */
    runs: 0,
    tokens: { tokensIn: 0, tokensOut: 0 },
    countedWhere: [] as unknown[]
};

vi.mock("@polaris/db", () => ({
    prisma: {
        agentUsageLimit: {
            findMany: vi.fn(async () => state.rules),
            upsert: vi.fn(async () => undefined),
            deleteMany: vi.fn(async () => ({ count: 0 }))
        },
        userRole: { findMany: vi.fn(async () => state.roles) },
        groupMember: { findMany: vi.fn(async () => state.groups) },
        agentRun: {
            count: vi.fn(async ({ where }: { where: unknown }) => {
                state.countedWhere.push(where);
                return state.runs;
            }),
            aggregate: vi.fn(async ({ where }: { where: unknown }) => {
                state.countedWhere.push(where);
                return { _sum: state.tokens };
            })
        }
    }
}));

const { checkUsageLimits } = await import("@/lib/agents/agent-usage-limits");

const RUN = { ownerId: "user-1", repoFullName: "FJRG2007/experiments" };

beforeEach(() => {
    state.rules = [];
    state.roles = [];
    state.groups = [];
    state.runs = 0;
    state.tokens = { tokensIn: 0, tokensOut: 0 };
    state.countedWhere = [];
});

describe("checkUsageLimits", () => {
    it("allows everything when nothing is limited, without counting anything", () => {
        // The common case, and the one that has to stay free.
        return checkUsageLimits(RUN).then((verdict) => {
            expect(verdict.allowed).toBe(true);
            expect(state.countedWhere).toEqual([]);
        });
    });

    it("refuses once a rule's ceiling is reached", async () => {
        state.rules = [{ subjectType: "everyone", subjectId: "", metric: "runs", period: "day", amount: 5 }];
        state.runs = 5;
        const verdict = await checkUsageLimits(RUN);
        expect(verdict.allowed).toBe(false);
        // The numbers are in the refusal: "over a limit" with none leaves somebody
        // unable to tell a ceiling worth asking about from one that clears in an hour.
        expect(verdict.reason).toContain("5 of the 5 runs");
    });

    it("allows the run that lands exactly under it", async () => {
        state.rules = [{ subjectType: "everyone", subjectId: "", metric: "runs", period: "day", amount: 5 }];
        state.runs = 4;
        expect((await checkUsageLimits(RUN)).allowed).toBe(true);
    });

    it("ignores a rule about somebody else", async () => {
        state.rules = [{ subjectType: "user", subjectId: "user-2", metric: "runs", period: "day", amount: 0 }];
        state.runs = 999;
        expect((await checkUsageLimits(RUN)).allowed).toBe(true);
        expect(state.countedWhere).toEqual([]);
    });

    it("ignores a rule about another repository", async () => {
        state.rules = [{ subjectType: "repo", subjectId: "acme/other", metric: "runs", period: "day", amount: 0 }];
        expect((await checkUsageLimits(RUN)).allowed).toBe(true);
    });

    it("applies a rule on the GitHub account the repository is under", async () => {
        state.rules = [{ subjectType: "org", subjectId: "fjrg2007", metric: "runs", period: "day", amount: 1 }];
        state.runs = 1;
        const verdict = await checkUsageLimits(RUN);
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain("Repositories under fjrg2007");
    });

    it("applies a rule on a role the person is in, counted for that person", async () => {
        state.rules = [{ subjectType: "role", subjectId: "role-a", metric: "runs", period: "day", amount: 2 }];
        state.roles = [{ roleId: "role-a" }];
        state.runs = 2;
        const verdict = await checkUsageLimits(RUN);
        expect(verdict.allowed).toBe(false);
        // Per member: the count is scoped to this person's repositories, never to
        // everything the role has ever done.
        expect(state.countedWhere[0]).toMatchObject({ repo: { ownerId: "user-1" } });
    });

    it("ignores a role the person is not in", async () => {
        state.rules = [{ subjectType: "role", subjectId: "role-b", metric: "runs", period: "day", amount: 0 }];
        state.roles = [{ roleId: "role-a" }];
        expect((await checkUsageLimits(RUN)).allowed).toBe(true);
    });

    it("counts both halves of a token budget", async () => {
        // A provider bills for what went in as well as what came out.
        state.rules = [{ subjectType: "everyone", subjectId: "", metric: "tokens", period: "month", amount: 1000 }];
        state.tokens = { tokensIn: 600, tokensOut: 400 };
        expect((await checkUsageLimits(RUN)).allowed).toBe(false);
    });

    it("lets the strictest rule decide, whatever order they arrive in", async () => {
        // No precedence to learn: every rule that applies has to pass.
        state.rules = [
            { subjectType: "everyone", subjectId: "", metric: "runs", period: "day", amount: 1000 },
            { subjectType: "repo", subjectId: "FJRG2007/experiments", metric: "runs", period: "day", amount: 2 }
        ];
        state.runs = 3;
        expect((await checkUsageLimits(RUN)).allowed).toBe(false);
    });

    it("matches a repository whatever case it was typed in", async () => {
        // GitHub names are case-insensitive; a rule that missed for a capital
        // letter would look like it was being ignored.
        state.rules = [{ subjectType: "repo", subjectId: "fjrg2007/EXPERIMENTS", metric: "runs", period: "day", amount: 0 }];
        expect((await checkUsageLimits(RUN)).allowed).toBe(false);
    });

    it("treats a ceiling of zero as a stop, not as no limit", async () => {
        state.rules = [{ subjectType: "everyone", subjectId: "", metric: "runs", period: "day", amount: 0 }];
        state.runs = 0;
        expect((await checkUsageLimits(RUN)).allowed).toBe(false);
    });
});
