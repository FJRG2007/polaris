/**
 * Pull request facts: the GraphQL projection (ported rules from Agent
 * Orchestrator's GitHub adapter), the read that never stores a partial answer,
 * the webhook's shapes and session matching, and the bounded poll.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    sessions: [] as Array<{ id: string; prNumber: number | null; branch: string }>,
    findSessionsArgs: [] as unknown[],
    updates: [] as unknown[],
    stale: [] as Array<{ sessionId: string; repoFullName: string; number: number }>,
    unseen: [] as Array<{ id: string; prNumber: number | null; repo: { repoFullName: string } | null }>,
    staleArgs: [] as unknown[],
    unseenArgs: [] as unknown[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            findMany: async (args: { where: { pullFacts?: unknown } }) => {
                if (args.where.pullFacts) {
                    db.unseenArgs.push(args);
                    return db.unseen;
                }
                db.findSessionsArgs.push(args);
                return db.sessions;
            },
            updateMany: async (args: unknown) => {
                db.updates.push(args);
                return { count: 1 };
            }
        },
        sessionPullFacts: {
            findMany: async (args: unknown) => {
                db.staleArgs.push(args);
                return db.stale;
            }
        }
    }
}));
vi.mock("@/lib/github-service", () => ({ githubAppInstallationToken: async () => "token" }));

const facts = await import("@/lib/agents/session-pr-facts");
const status = await import("@/lib/agents/session-status");

type PullNode = facts.PullNode;
type ContextNode = facts.ContextNode;

function checkRun(extra: Partial<ContextNode> = {}): ContextNode {
    return { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", ...extra };
}

function workflowRun(name: string, id: number, conclusion: string, check = "test"): ContextNode {
    return checkRun({
        name: check,
        conclusion,
        databaseId: id,
        checkSuite: { workflowRun: { event: "pull_request", workflow: { name } } }
    });
}

function pull(extra: Partial<PullNode> = {}, contexts?: ContextNode[], hasNextPage = false): PullNode {
    return {
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        state: "OPEN",
        isDraft: false,
        merged: false,
        closed: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: null,
        headRefOid: "abc",
        headRefName: "polar/fix",
        baseRefName: "main",
        commits: contexts
            ? {
                  nodes: [
                      {
                          commit: {
                              statusCheckRollup: {
                                  state: "SUCCESS",
                                  contexts: { nodes: contexts, pageInfo: { hasNextPage } }
                              }
                          }
                      }
                  ]
              }
            : { nodes: [] },
        reviewThreads: { nodes: [] },
        ...extra
    };
}

describe("checkVerdict", () => {
    it.each<[ContextNode, string]>([
        [{ __typename: "StatusContext", state: "SUCCESS" }, "passed"],
        [{ __typename: "StatusContext", state: "FAILURE" }, "failed"],
        [{ __typename: "StatusContext", state: "ERROR" }, "failed"],
        [{ __typename: "StatusContext", state: "PENDING" }, "running"],
        [{ __typename: "StatusContext", state: "EXPECTED" }, "running"],
        [{ __typename: "StatusContext", state: "weird" }, "unknown"],
        [checkRun({ conclusion: "SUCCESS" }), "passed"],
        [checkRun({ conclusion: "NEUTRAL" }), "passed"],
        [checkRun({ conclusion: "FAILURE" }), "failed"],
        [checkRun({ conclusion: "TIMED_OUT" }), "failed"],
        [checkRun({ conclusion: "ACTION_REQUIRED" }), "failed"],
        [checkRun({ conclusion: "STARTUP_FAILURE" }), "failed"],
        [checkRun({ conclusion: "CANCELLED" }), "cancelled"],
        [checkRun({ conclusion: "SKIPPED" }), "skipped"],
        [checkRun({ conclusion: "STALE" }), "skipped"],
        [checkRun({ conclusion: null, status: "QUEUED" }), "queued"],
        [checkRun({ conclusion: null, status: "WAITING" }), "queued"],
        [checkRun({ conclusion: null, status: "IN_PROGRESS" }), "running"],
        [checkRun({ conclusion: null, status: "COMPLETED" }), "unknown"],
        [checkRun({ conclusion: "FAILURE", status: "IN_PROGRESS" }), "failed"]
    ])("%o -> %s", (node, want) => {
        expect(facts.checkVerdict(node)).toBe(want);
    });
});

describe("latestCheckRuns", () => {
    it("keeps only the newest run of each workflow, event and check", () => {
        const old = workflowRun("CI", 1, "FAILURE");
        const rerun = workflowRun("CI", 2, "SUCCESS");
        const other = workflowRun("CI", 3, "SUCCESS", "lint");
        const foreign = checkRun({ name: "external", databaseId: 0 });
        expect(facts.latestCheckRuns([old, rerun, other, foreign])).toEqual([rerun, other, foreign]);
    });
});

describe("ciSummary", () => {
    it.each<[string, ContextNode[] | undefined, boolean, string]>([
        ["no rollup", undefined, false, "unknown"],
        ["all passing", [checkRun(), { __typename: "StatusContext", state: "SUCCESS" }], false, "passing"],
        ["one failing", [checkRun(), checkRun({ conclusion: "FAILURE" })], false, "failing"],
        ["pending wins over passing", [checkRun(), checkRun({ conclusion: null, status: "QUEUED" })], false, "pending"],
        ["cancelled alone is unknown", [checkRun({ conclusion: "CANCELLED" })], false, "unknown"],
        ["cancelled beside passing is unknown", [checkRun(), checkRun({ conclusion: "CANCELLED" })], false, "unknown"],
        ["skipped only is unknown", [checkRun({ conclusion: "SKIPPED" })], false, "unknown"],
        ["failure survives a next page", [checkRun({ conclusion: "FAILURE" })], true, "failing"],
        ["passing degrades on a next page", [checkRun()], true, "unknown"],
        ["failed attempt superseded by a green re-run", [workflowRun("CI", 1, "FAILURE"), workflowRun("CI", 2, "SUCCESS")], false, "passing"]
    ])("%s", (_name, contexts, more, want) => {
        const node = contexts ? pull({}, contexts, more) : pull();
        expect(facts.ciSummary(node).checks).toBe(want);
    });

    it("falls back to the rollup's own state when it lists nothing", () => {
        const node = pull({}, []);
        node.commits!.nodes[0]!.commit.statusCheckRollup!.state = "FAILURE";
        expect(facts.ciSummary(node).checks).toBe("failing");
        node.commits!.nodes[0]!.commit.statusCheckRollup!.state = "PENDING";
        expect(facts.ciSummary(node).checks).toBe("pending");
    });

    it("counts the newest runs", () => {
        const summary = facts.ciSummary(
            pull({}, [checkRun({ conclusion: "FAILURE" }), checkRun({ conclusion: null, status: "IN_PROGRESS" }), checkRun()])
        );
        expect(summary).toEqual({ checks: "failing", checksTotal: 3, checksFailed: 1, checksPending: 1 });
    });
});

describe("reviewDecision", () => {
    it.each([
        ["APPROVED", "approved"],
        ["CHANGES_REQUESTED", "changes_requested"],
        ["REVIEW_REQUIRED", "review_required"],
        [null, "none"],
        ["SOMETHING_NEW", "none"]
    ])("%s -> %s", (raw, want) => {
        expect(facts.reviewDecision(raw)).toBe(want);
    });
});

describe("mergeability rules, first match wins", () => {
    const base = { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", isDraft: false };
    it.each<[string, Partial<typeof base> & { mergeable?: string | null; mergeStateStatus?: string | null }, string, string, string]>([
        ["dirty", { mergeStateStatus: "DIRTY" }, "passing", "none", "conflicting"],
        ["blocked", { mergeStateStatus: "BLOCKED" }, "passing", "none", "blocked"],
        ["unstable", { mergeStateStatus: "UNSTABLE" }, "passing", "none", "unstable"],
        ["conflicting flag", { mergeStateStatus: "UNKNOWN", mergeable: "CONFLICTING" }, "passing", "none", "conflicting"],
        ["draft", { isDraft: true }, "passing", "none", "blocked"],
        ["changes requested", {}, "passing", "changes_requested", "blocked"],
        ["review required", {}, "passing", "review_required", "blocked"],
        ["CI failing", {}, "failing", "none", "blocked"],
        ["clean and mergeable", {}, "passing", "none", "mergeable"],
        ["clean and approved", {}, "passing", "approved", "mergeable"],
        ["not computed yet", { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, "passing", "none", "unknown"],
        ["behind", { mergeStateStatus: "BEHIND" }, "passing", "none", "unknown"],
        ["dirty beats draft", { mergeStateStatus: "DIRTY", isDraft: true }, "failing", "changes_requested", "conflicting"]
    ])("%s", (_name, extra, ci, review, want) => {
        expect(
            facts.mergeability(
                { ...base, ...extra },
                ci as Parameters<typeof facts.mergeability>[1],
                review as Parameters<typeof facts.mergeability>[2]
            )
        ).toBe(want);
    });
});

describe("unresolvedThreads", () => {
    it("counts unresolved threads with a person's comment, never a bot's alone", () => {
        const thread = (isResolved: boolean, ...types: string[]) => ({
            isResolved,
            comments: { nodes: types.map((type) => ({ author: { login: "x", __typename: type } })) }
        });
        const node = pull({
            reviewThreads: {
                nodes: [
                    thread(false, "User"),
                    thread(true, "User"),
                    thread(false, "Bot"),
                    thread(false, "Bot", "User"),
                    null,
                    { isResolved: false, comments: { nodes: [{ author: null }] } }
                ]
            }
        });
        expect(facts.unresolvedThreads(node)).toBe(2);
    });
});

describe("observationFrom", () => {
    it("projects an open pull request", () => {
        expect(facts.observationFrom(pull({ reviewDecision: "APPROVED" }, [checkRun()]))).toEqual({
            number: 7,
            url: "https://github.com/acme/app/pull/7",
            state: "open",
            draft: false,
            mergeable: "mergeable",
            checks: "passing",
            checksTotal: 1,
            checksFailed: 0,
            checksPending: 0,
            review: "approved",
            unresolvedComments: 0,
            headSha: "abc",
            sourceBranch: "polar/fix",
            targetBranch: "main"
        });
    });

    it("keeps merged and closed exclusive", () => {
        expect(facts.observationFrom(pull({ state: "MERGED", merged: true, closed: true })).state).toBe("merged");
        expect(facts.observationFrom(pull({ state: "CLOSED", closed: true })).state).toBe("closed");
    });

    it("feeds the derived status through a stored row", () => {
        const observation = facts.observationFrom(pull({ mergeStateStatus: "DIRTY" }));
        const row = { ...observation, unresolvedComments: 0 };
        expect(status.deriveScmStatus([facts.pullFactsOf(row)])).toBe("merge_conflict");
    });
});

describe("pullFactsOf", () => {
    it("reads an unknown stored word as the neutral value", () => {
        expect(
            facts.pullFactsOf({
                url: "u",
                state: "open",
                draft: false,
                mergeable: "sideways",
                checks: "maybe",
                review: "meh",
                unresolvedComments: 3,
                sourceBranch: "a",
                targetBranch: "main"
            })
        ).toEqual({
            url: "u",
            draft: false,
            merged: false,
            closed: false,
            ci: "unknown",
            review: "none",
            mergeability: "unknown",
            reviewComments: true,
            sourceBranch: "a",
            targetBranch: "main"
        });
    });
});

describe("fetchPullObservation", () => {
    const answer = (body: unknown, init: ResponseInit = {}) =>
        (async () => new Response(JSON.stringify(body), { status: 200, ...init })) as unknown as typeof fetch;

    it("reads a pull request", async () => {
        const fetchImpl = vi.fn(answer({ data: { repository: { pullRequest: pull() } } }));
        const outcome = await facts.fetchPullObservation("acme", "app", 7, "t", fetchImpl);
        expect(outcome.kind).toBe("ok");
        const [url, init] = fetchImpl.mock.calls[0]!;
        expect(url).toBe("https://api.github.com/graphql");
        expect(JSON.parse(String((init as RequestInit).body)).variables).toEqual({ owner: "acme", repo: "app", number: 7 });
    });

    it.each<[string, typeof fetch, string]>([
        ["429", answer({}, { status: 429 }), "limited"],
        ["403 out of quota", answer({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } }), "limited"],
        ["403 otherwise", answer({}, { status: 403 }), "failed"],
        ["500", answer({}, { status: 500 }), "failed"],
        ["RATE_LIMITED", answer({ errors: [{ type: "RATE_LIMITED", message: "x" }] }), "limited"],
        ["NOT_FOUND", answer({ data: { repository: null }, errors: [{ type: "NOT_FOUND" }] }), "missing"],
        ["null pull request", answer({ data: { repository: { pullRequest: null } } }), "missing"],
        [
            "partial answer with an error",
            answer({ data: { repository: { pullRequest: pull() } }, errors: [{ type: "SOMETHING" }] }),
            "failed"
        ],
        ["malformed body", answer({ data: { repository: { pullRequest: { number: "seven" } } } }), "failed"],
        ["not JSON", (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch, "failed"],
        [
            "network failure",
            (async () => {
                throw new Error("offline");
            }) as unknown as typeof fetch,
            "failed"
        ]
    ])("%s -> %s", async (_name, fetchImpl, want) => {
        expect((await facts.fetchPullObservation("acme", "app", 7, "t", fetchImpl)).kind).toBe(want);
    });
});

describe("refreshPullFacts", () => {
    const observation = facts.observationFrom(pull());

    it("asks for one token per owner and writes what it read", async () => {
        const token = vi.fn(async (owner: string) => (owner === "nobody" ? null : `t-${owner}`));
        const fetch = vi.fn(async (_o: string, _r: string, number: number) => ({
            kind: "ok" as const,
            observation: { ...observation, number }
        }));
        const write = vi.fn(async () => undefined);
        const result = await facts.refreshPullFacts(
            [
                { sessionId: "s1", repoFullName: "acme/app", number: 1 },
                { sessionId: "s2", repoFullName: "acme/web", number: 2 },
                { sessionId: "s3", repoFullName: "nobody/app", number: 3 },
                { sessionId: "s4", repoFullName: "broken", number: 4 }
            ],
            { token, fetch, write }
        );
        expect(result).toEqual({ written: 2, limited: false });
        expect(token).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("stops at the first sign of an exhausted quota", async () => {
        const fetch = vi.fn(async () => ({ kind: "limited" as const }));
        const write = vi.fn(async () => undefined);
        const result = await facts.refreshPullFacts(
            [
                { sessionId: "s1", repoFullName: "acme/app", number: 1 },
                { sessionId: "s2", repoFullName: "acme/app", number: 2 }
            ],
            { token: async () => "t", fetch, write }
        );
        expect(result).toEqual({ written: 0, limited: true });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(write).not.toHaveBeenCalled();
    });

    it("never writes a failed read or an answer about another number", async () => {
        const outcomes = [{ kind: "failed" as const }, { kind: "missing" as const }, { kind: "ok" as const, observation }];
        const write = vi.fn(async () => undefined);
        await facts.refreshPullFacts(
            outcomes.map((_, index) => ({ sessionId: `s${index}`, repoFullName: "acme/app", number: 99 })),
            { token: async () => "t", fetch: async () => outcomes.shift()!, write }
        );
        expect(write).not.toHaveBeenCalled();
    });

    it("keeps going when one write fails", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const write = vi.fn().mockRejectedValueOnce(new Error("db")).mockResolvedValue(undefined);
        const result = await facts.refreshPullFacts(
            [
                { sessionId: "s1", repoFullName: "acme/app", number: 7 },
                { sessionId: "s2", repoFullName: "acme/app", number: 7 }
            ],
            { token: async () => "t", fetch: async () => ({ kind: "ok", observation }), write }
        );
        expect(result.written).toBe(1);
        error.mockRestore();
    });
});

describe("webhookSubject", () => {
    const repository = { full_name: "acme/app" };
    const pr = { number: 7, head: { ref: "polar/fix" } };

    it.each(["pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread"] as const)(
        "reads %s",
        (event) => {
            expect(facts.webhookSubject(event, { action: "x", repository, pull_request: pr })).toEqual({
                repoFullName: "acme/app",
                numbers: [7],
                branches: ["polar/fix"]
            });
        }
    );

    it("reads check_suite with and without pull requests", () => {
        expect(
            facts.webhookSubject("check_suite", {
                repository,
                check_suite: { head_branch: "polar/fix", pull_requests: [{ number: 7 }, { number: 8 }] }
            })
        ).toEqual({ repoFullName: "acme/app", numbers: [7, 8], branches: ["polar/fix"] });
        expect(
            facts.webhookSubject("check_suite", { repository, check_suite: { head_branch: null, pull_requests: [] } })
        ).toEqual({ repoFullName: "acme/app", numbers: [], branches: [] });
    });

    it("reads check_run", () => {
        expect(
            facts.webhookSubject("check_run", {
                repository,
                check_run: { check_suite: { head_branch: "polar/fix" }, pull_requests: [{ number: 7 }] }
            })
        ).toEqual({ repoFullName: "acme/app", numbers: [7], branches: ["polar/fix"] });
    });

    it.each<[facts.PullFactEvent, unknown]>([
        ["pull_request", null],
        ["pull_request", { repository, pull_request: { number: -1, head: { ref: "a" } } }],
        ["pull_request", { repository, pull_request: { number: 7 } }],
        ["pull_request", { repository: { full_name: "no-slash" }, pull_request: pr }],
        ["pull_request", { repository: { full_name: "a/b/../c" }, pull_request: pr }],
        ["pull_request_review", { repository }],
        ["check_suite", { repository }],
        ["check_suite", { repository, check_suite: { pull_requests: [{ number: "7" }] } }],
        ["check_run", { repository, check_run: { pull_requests: Array.from({ length: 51 }, () => ({ number: 1 })) } }]
    ])("refuses a malformed %s", (event, payload) => {
        expect(facts.webhookSubject(event, payload)).toBeNull();
    });

    it("names exactly the events it reads", () => {
        expect(facts.isPullFactEvent("pull_request")).toBe(true);
        expect(facts.isPullFactEvent("check_run")).toBe(true);
        expect(facts.isPullFactEvent("push")).toBe(false);
        expect(facts.isPullFactEvent("toString")).toBe(false);
    });
});

describe("targetsFor", () => {
    const subject = { repoFullName: "acme/app", numbers: [7], branches: ["polar/fix"] };

    it("matches by recorded number, then by branch", () => {
        expect(
            facts.targetsFor(subject, [
                { id: "a", prNumber: 7, branch: "polar/other" },
                { id: "b", prNumber: null, branch: "polar/fix" },
                { id: "c", prNumber: 3, branch: "polar/unrelated" }
            ])
        ).toEqual([
            { sessionId: "a", repoFullName: "acme/app", number: 7 },
            { sessionId: "b", repoFullName: "acme/app", number: 7 }
        ]);
    });

    it("uses the session's own pull request for a check that names none", () => {
        expect(
            facts.targetsFor({ ...subject, numbers: [] }, [
                { id: "a", prNumber: 5, branch: "polar/fix" },
                { id: "b", prNumber: null, branch: "polar/fix" }
            ])
        ).toEqual([{ sessionId: "a", repoFullName: "acme/app", number: 5 }]);
    });

    it("caps how many refreshes one delivery starts", () => {
        const sessions = Array.from({ length: 30 }, (_, index) => ({ id: `s${index}`, prNumber: 7, branch: "x" }));
        expect(facts.targetsFor(subject, sessions)).toHaveLength(10);
    });
});

describe("onPullFactWebhook", () => {
    beforeEach(() => {
        db.sessions = [];
        db.findSessionsArgs = [];
        db.updates = [];
    });

    const deps = () => ({
        token: async () => "t",
        fetch: vi.fn(async (_o: string, _r: string, number: number) => ({
            kind: "ok" as const,
            observation: { ...facts.observationFrom(pull()), number }
        })),
        write: vi.fn(async () => undefined)
    });

    it("refreshes the sessions a pull request names and links an unlinked one", async () => {
        db.sessions = [{ id: "b", prNumber: null, branch: "polar/fix" }];
        const d = deps();
        const refreshes = await facts.onPullFactWebhook(
            "pull_request",
            { repository: { full_name: "acme/app" }, pull_request: { number: 7, head: { ref: "polar/fix" } } },
            d
        );
        await Promise.all(refreshes);
        expect(d.write).toHaveBeenCalledWith({ sessionId: "b", repoFullName: "acme/app", number: 7 }, expect.anything());
        expect(db.updates).toEqual([
            {
                where: { id: "b", prNumber: null },
                data: { prNumber: 7, prUrl: "https://github.com/acme/app/pull/7" }
            }
        ]);
        expect(db.findSessionsArgs[0]).toMatchObject({
            where: { repo: { repoFullName: "acme/app" } },
            take: 10
        });
    });

    it("does nothing for a malformed delivery", async () => {
        expect(await facts.onPullFactWebhook("pull_request", { nope: true }, deps())).toEqual([]);
        expect(db.findSessionsArgs).toHaveLength(0);
    });

    it("coalesces a burst about one pull request into a read and one follow-up", async () => {
        db.sessions = [{ id: "a", prNumber: 7, branch: "polar/fix" }];
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const d = deps();
        const read = d.fetch.getMockImplementation()!;
        d.fetch.mockImplementation(async (...args: [string, string, number]) => {
            await gate;
            return read(...args);
        });
        const payload = {
            repository: { full_name: "acme/app" },
            pull_request: { number: 7, head: { ref: "polar/fix" } }
        };
        const first = await facts.onPullFactWebhook("pull_request_review", payload, d);
        const second = await facts.onPullFactWebhook("pull_request_review_comment", payload, d);
        const third = await facts.onPullFactWebhook("pull_request_review_comment", payload, d);
        release();
        await Promise.all([...first, ...second, ...third]);
        expect(d.fetch).toHaveBeenCalledTimes(2);
    });
});

describe("pollPullFacts", () => {
    beforeEach(() => {
        db.stale = [];
        db.unseen = [];
        db.staleArgs = [];
        db.unseenArgs = [];
    });

    const now = new Date("2026-11-15T12:00:00Z");
    const deps = () => ({
        token: async () => "t",
        fetch: vi.fn(async (_o: string, _r: string, number: number) => ({
            kind: "ok" as const,
            observation: { ...facts.observationFrom(pull()), number }
        })),
        write: vi.fn(async () => undefined)
    });

    it("asks for open, stale rows of live or recent sessions, stalest first, bounded", async () => {
        db.stale = [{ sessionId: "s1", repoFullName: "acme/app", number: 1 }];
        const d = deps();
        expect(await facts.pollPullFacts(now, d)).toEqual({ asked: 1, written: 1, limited: false });
        expect(db.staleArgs[0]).toMatchObject({
            where: { state: "open", fetchedAt: { lt: new Date(now.getTime() - facts.POLL_MAX_AGE_MS) } },
            orderBy: { fetchedAt: "asc" },
            take: facts.POLL_BATCH
        });
        expect(db.unseenArgs[0]).toMatchObject({ take: facts.POLL_BATCH - 1 });
    });

    it("adds sessions with a recorded pull request and no facts yet", async () => {
        db.unseen = [
            { id: "s2", prNumber: 4, repo: { repoFullName: "acme/app" } },
            { id: "s3", prNumber: 5, repo: null }
        ];
        const d = deps();
        expect(await facts.pollPullFacts(now, d)).toEqual({ asked: 1, written: 1, limited: false });
        expect(d.write).toHaveBeenCalledWith({ sessionId: "s2", repoFullName: "acme/app", number: 4 }, expect.anything());
    });

    it("skips the second query when the stale rows fill the pass", async () => {
        db.stale = Array.from({ length: facts.POLL_BATCH }, (_, index) => ({
            sessionId: `s${index}`,
            repoFullName: "acme/app",
            number: index + 1
        }));
        const d = deps();
        const result = await facts.pollPullFacts(now, d);
        expect(result.asked).toBe(facts.POLL_BATCH);
        expect(db.unseenArgs).toHaveLength(0);
    });
});
