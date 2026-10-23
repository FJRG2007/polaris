/**
 * "Wait for CI": a held push deploys on green, not on red, at most once; a newer
 * push supersedes an older one still waiting; a re-run that turns green later
 * still deploys; a commit with no checks deploys after the grace minute; and a
 * missed webhook is caught by the poller.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Wait = {
    id: string;
    applicationId: string;
    repoFullName: string;
    branch: string;
    commitSha: string;
    commitMessage: string;
    authorName: string | null;
    authorAvatarUrl: string | null;
    status: string;
    failedCheck: string | null;
    createdAt: Date;
    checkedAt: Date;
};

const state = vi.hoisted(() => ({
    waits: [] as Wait[],
    app: {
        id: "app-1",
        lastDeployedSha: "old" as string | null,
        autoDeploy: true,
        waitForCi: true,
        environment: { project: { ownerId: "owner-1" } }
    },
    lines: [] as { action: string; fromValue?: string | null; toValue?: string | null }[],
    checks: { status: 200, runs: [] as unknown[] },
    commitStatuses: { status: 200, statuses: [] as unknown[] },
    deploys: [] as string[]
}));

/** A where clause the way the module writes them. */
function matches(row: Wait, where: Record<string, unknown>): boolean {
    for (const [key, want] of Object.entries(where)) {
        const have = (row as Record<string, unknown>)[key];
        if (want && typeof want === "object" && !(want instanceof Date)) {
            const clause = want as { in?: unknown[]; not?: unknown; lt?: Date };
            if (clause.in && !clause.in.includes(have)) return false;
            if ("not" in clause && have === clause.not) return false;
            if (clause.lt && !((have as Date) < clause.lt)) return false;
        } else if (have !== want) return false;
    }
    return true;
}

const withApp = (row: Wait) => ({ ...row, application: state.app });

vi.mock("@polaris/db", () => ({
    prisma: {
        deployCiWait: {
            findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
                const row = state.waits.find((wait) => matches(wait, where));
                return row ? withApp(row) : null;
            }),
            upsert: vi.fn(
                async ({ where, create }: { where: { applicationId: string }; create: Wait }) => {
                    const found = state.waits.find(
                        (wait) => wait.applicationId === where.applicationId
                    );
                    if (found) return found;
                    const row = { ...create, id: `wait-${state.waits.length + 1}` };
                    state.waits.push(row);
                    return row;
                }
            ),
            updateMany: vi.fn(
                async ({
                    where,
                    data
                }: {
                    where: Record<string, unknown>;
                    data: Partial<Wait>;
                }) => {
                    const rows = state.waits.filter((wait) => matches(wait, where));
                    for (const row of rows) Object.assign(row, data);
                    return { count: rows.length };
                }
            ),
            findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
                state.waits.filter((wait) => matches(wait, where)).map(withApp)
            ),
            deleteMany: vi.fn(async () => ({ count: 0 }))
        }
    }
}));
vi.mock("@/lib/activity/activity", () => ({
    record: vi.fn(async (entry: { action: string }) => {
        state.lines.push(entry);
    })
}));
vi.mock("@/lib/deploy/pushed-commit", () => ({
    deployPushedCommit: vi.fn(
        async (app: { id: string }, _owner: string, commit: { commitSha: string }) => {
            if (state.app.lastDeployedSha === commit.commitSha) return false;
            state.app.lastDeployedSha = commit.commitSha;
            state.deploys.push(commit.commitSha);
            return true;
        }
    )
}));
vi.mock("@/lib/github-access", () => ({ githubTokenForOwner: vi.fn(async () => "token") }));
vi.mock("@/lib/github-service", () => ({ githubAppHandle: vi.fn(async () => "polaris-here") }));

globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes("/status?")) {
        return state.commitStatuses.status === 200
            ? new Response(
                  JSON.stringify({ state: "pending", statuses: state.commitStatuses.statuses }),
                  {
                      status: 200
                  }
              )
            : new Response("{}", { status: state.commitStatuses.status });
    }
    return state.checks.status === 200
        ? new Response(
              JSON.stringify({
                  total_count: state.checks.runs.length,
                  check_runs: state.checks.runs
              }),
              { status: 200 }
          )
        : new Response("{}", { status: state.checks.status });
}) as typeof fetch;

const ciWait = await import("@/lib/deploy/ci-wait");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const run = (name: string, status: string, conclusion: string | null, slug = "github-actions") => ({
    name,
    status,
    conclusion,
    app: { slug }
});
const status = (context: string, value: string, login = "jenkins") => ({
    context,
    state: value,
    creator: { login }
});
const push = (sha: string) => ({
    commitSha: sha,
    commitMessage: "feat: a push",
    repoFullName: "Owner/Repo",
    branch: "main"
});

/** Make the held row look as old as `ms`, as the clock would. */
function age(ms: number) {
    for (const wait of state.waits) {
        wait.createdAt = new Date(Date.now() - ms);
        wait.checkedAt = new Date(Date.now() - ms);
    }
}

beforeEach(() => {
    state.waits = [];
    state.lines = [];
    state.deploys = [];
    state.app.lastDeployedSha = "old";
    state.app.waitForCi = true;
    state.app.autoDeploy = true;
    state.checks = { status: 200, runs: [] };
    state.commitStatuses = { status: 200, statuses: [] };
});

describe("judging the checks on a commit", () => {
    const judge = (status: number, runs: ReturnType<typeof run>[], ageMs = 120_000) =>
        ciWait.judgeChecks({ status, runs, ownSlug: "polaris-here", ageMs });

    it("is green when every check passed, skipped ones included", () => {
        expect(
            judge(200, [run("test", "completed", "success"), run("lint", "completed", "skipped")])
        ).toEqual({
            state: "green"
        });
    });
    it("names the check that failed", () => {
        expect(
            judge(200, [run("test", "completed", "failure"), run("lint", "in_progress", null)])
        ).toEqual({
            state: "failed",
            check: "test"
        });
    });
    it("waits while any check is still running", () => {
        expect(
            judge(200, [run("test", "completed", "success"), run("e2e", "queued", null)]).state
        ).toBe("pending");
    });
    it("leaves Polaris's own row on the commit out", () => {
        expect(judge(200, [run("my-service", "in_progress", null, "polaris-here")]).state).toBe(
            "green"
        );
    });
    it("takes a commit with no checks as green only after the grace minute", () => {
        expect(judge(200, [], 5_000).state).toBe("pending");
        expect(judge(200, [], ciWait.NO_CHECKS_GRACE_MS).state).toBe("green");
    });
    it("reads commit statuses as checks too", () => {
        const judgeStatuses = (
            statuses: ReturnType<typeof status>[],
            runs: ReturnType<typeof run>[] = []
        ) =>
            ciWait.judgeChecks({
                status: 200,
                runs,
                statuses,
                ownSlug: "polaris-here",
                ageMs: 120_000
            });
        expect(judgeStatuses([status("ci/jenkins", "pending")]).state).toBe("pending");
        expect(judgeStatuses([status("ci/jenkins", "failure")])).toEqual({
            state: "failed",
            check: "ci/jenkins"
        });
        expect(judgeStatuses([status("ci/jenkins", "error")]).state).toBe("failed");
        expect(
            judgeStatuses([status("ci/jenkins", "pending")], [run("test", "completed", "success")])
                .state
        ).toBe("pending");
        expect(judgeStatuses([status("ci/jenkins", "success")]).state).toBe("green");
        expect(judgeStatuses([status("deploy", "pending", "polaris-here[bot]")]).state).toBe(
            "green"
        );
    });
    it("tells a refusal from a blink", () => {
        expect(judge(403, []).state).toBe("unreadable");
        expect(judge(0, []).state).toBe("pending");
    });
});

describe("a push held for CI", () => {
    it("is not deployed when it arrives, and is deployed once on green", async () => {
        expect(await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A))).toBe(false);
        expect(state.deploys).toEqual([]);
        expect(state.lines.map((line) => line.action)).toEqual(["ci-waiting"]);

        state.checks.runs = [run("test", "completed", "success")];
        const [first, second] = await Promise.all([
            ciWait.onChecksFinished("owner/repo", SHA_A),
            ciWait.onChecksFinished("owner/repo", SHA_A)
        ]);
        expect(first + second).toBe(1);
        expect(state.deploys).toEqual([SHA_A]);
        expect(state.waits[0]?.status).toBe("deployed");
    });

    it("is not deployed on red, and the activity names the failed check once", async () => {
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A));
        state.checks.runs = [run("unit tests", "completed", "failure")];
        await ciWait.onChecksFinished("owner/repo", SHA_A);
        await ciWait.onChecksFinished("owner/repo", SHA_A);
        expect(state.deploys).toEqual([]);
        const failed = state.lines.filter((line) => line.action === "ci-failed");
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({ fromValue: SHA_A, toValue: "unit tests" });
    });

    it("still deploys when a re-run of the failed check turns green", async () => {
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A));
        state.checks.runs = [run("test", "completed", "failure")];
        await ciWait.onChecksFinished("owner/repo", SHA_A);
        state.checks.runs = [run("test", "completed", "success")];
        await ciWait.onChecksFinished("owner/repo", SHA_A);
        expect(state.deploys).toEqual([SHA_A]);
    });

    it("is superseded by a newer push to the branch", async () => {
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A));
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_B));
        expect(state.waits).toHaveLength(1);
        expect(state.waits[0]?.commitSha).toBe(SHA_B);
        state.checks.runs = [run("test", "completed", "success")];
        // The older commit's checks finishing deploys nothing.
        expect(await ciWait.onChecksFinished("owner/repo", SHA_A)).toBe(0);
        expect(await ciWait.onChecksFinished("owner/repo", SHA_B)).toBe(1);
        expect(state.deploys).toEqual([SHA_B]);
    });

    it("is one hold however often the same push is seen", async () => {
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A));
        state.checks.runs = [run("test", "completed", "failure")];
        await ciWait.onChecksFinished("owner/repo", SHA_A);
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A));
        expect(state.waits).toHaveLength(1);
        expect(state.waits[0]?.status).toBe("failed");
        expect(state.lines.filter((line) => line.action === "ci-waiting")).toHaveLength(1);
    });

    it("deploys a repository with no checks once the grace minute is over", async () => {
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A));
        await ciWait.pollCiWaits();
        expect(state.deploys).toEqual([]);
        age(ciWait.NO_CHECKS_GRACE_MS + 5_000);
        await ciWait.pollCiWaits();
        expect(state.deploys).toEqual([SHA_A]);
    });

    it("is deployed by the poller when the webhook never arrives", async () => {
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A));
        state.checks.runs = [run("test", "completed", "success")];
        age(2 * 60_000);
        await ciWait.pollCiWaits();
        expect(state.deploys).toEqual([SHA_A]);
    });

    it("gives up after the timeout and says so", async () => {
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A));
        state.checks.runs = [run("slow", "in_progress", null)];
        age(ciWait.CI_WAIT_TIMEOUT_MS + 1_000);
        await ciWait.pollCiWaits();
        expect(state.deploys).toEqual([]);
        expect(state.waits[0]?.status).toBe("expired");
        expect(state.lines.map((line) => line.action)).toContain("ci-timeout");
        // Seen again by the poller, the same commit is not waited on again.
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A));
        expect(state.waits[0]?.status).toBe("expired");
    });

    it("waits for CI that reports through commit statuses, and deploys once it passes", async () => {
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A));
        age(ciWait.NO_CHECKS_GRACE_MS + 5_000);
        state.commitStatuses.statuses = [status("ci/jenkins", "pending")];
        await ciWait.pollCiWaits();
        expect(state.deploys).toEqual([]);
        state.commitStatuses.statuses = [status("ci/jenkins", "failure")];
        await ciWait.onChecksFinished("owner/repo", SHA_A);
        expect(state.deploys).toEqual([]);
        expect(state.lines.find((line) => line.action === "ci-failed")).toMatchObject({
            toValue: "ci/jenkins"
        });
        state.commitStatuses.statuses = [status("ci/jenkins", "success")];
        await ciWait.onChecksFinished("owner/repo", SHA_A);
        expect(state.deploys).toEqual([SHA_A]);
    });

    it("takes statuses GitHub will not show as none", async () => {
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A));
        state.checks.runs = [run("test", "completed", "success")];
        state.commitStatuses.status = 403;
        await ciWait.onChecksFinished("owner/repo", SHA_A);
        expect(state.deploys).toEqual([SHA_A]);
    });

    it("keeps waiting when the statuses could not be read for a moment", async () => {
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A));
        state.checks.runs = [run("test", "completed", "success")];
        state.commitStatuses.status = 502;
        await ciWait.onChecksFinished("owner/repo", SHA_A);
        expect(state.deploys).toEqual([]);
        expect(state.waits[0]?.status).toBe("waiting");
    });

    it("says when GitHub will not show the checks", async () => {
        await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A));
        state.checks.status = 403;
        await ciWait.onChecksFinished("owner/repo", SHA_A);
        expect(state.deploys).toEqual([]);
        expect(state.lines.map((line) => line.action)).toContain("ci-unreadable");
    });

    it("deploys at once when the service does not wait for CI", async () => {
        state.app.waitForCi = false;
        expect(await ciWait.deployOrHold(state.app, "owner-1", push(SHA_A))).toBe(true);
        expect(state.waits).toHaveLength(0);
    });
});

describe("a finished check from the webhook", () => {
    const repository = { full_name: "Owner/Repo" };
    it("is read from each of GitHub's three shapes", () => {
        expect(
            ciWait.finishedCheckOf("check_suite", {
                action: "completed",
                repository,
                check_suite: { head_sha: SHA_A }
            })
        ).toEqual({ repoFullName: "Owner/Repo", sha: SHA_A });
        expect(
            ciWait.finishedCheckOf("workflow_run", {
                action: "completed",
                repository,
                workflow_run: { head_sha: SHA_A }
            })
        ).toEqual({ repoFullName: "Owner/Repo", sha: SHA_A });
        expect(
            ciWait.finishedCheckOf("check_run", {
                action: "completed",
                repository,
                check_run: { head_sha: SHA_A }
            })
        ).toEqual({ repoFullName: "Owner/Repo", sha: SHA_A });
    });
    it("ignores one that has not finished, or is malformed", () => {
        expect(
            ciWait.finishedCheckOf("check_suite", {
                action: "requested",
                repository,
                check_suite: { head_sha: SHA_A }
            })
        ).toBeNull();
        expect(
            ciWait.finishedCheckOf("check_suite", {
                action: "completed",
                repository,
                check_suite: { head_sha: "nope" }
            })
        ).toBeNull();
        expect(ciWait.finishedCheckOf("push", { action: "completed", repository })).toBeNull();
        expect(ciWait.finishedCheckOf("check_suite", null)).toBeNull();
    });
});
