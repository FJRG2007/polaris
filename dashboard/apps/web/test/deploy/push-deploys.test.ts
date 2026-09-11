/**
 * One push, one deploy.
 *
 * A push reaches a service through the webhook and through the poller, and a
 * webhook can be delivered twice. On a live server one push started two deploys
 * of the same commit and the second died on the first's container name. These
 * pin that the commit is claimed before a deploy starts: whoever arrives second
 * finds it taken, and a deploy that could not start hands it back for a retry.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const row = { id: "app-1", lastDeployedSha: "old" as string | null };

const { deployApplication, findMany } = vi.hoisted(() => ({
    deployApplication: vi.fn(async () => "dep-1"),
    findMany: vi.fn()
}));

/** `updateMany` the way one UPDATE ... WHERE behaves: the check and the write are one step. */
function updateMany({
    where,
    data
}: {
    where: Record<string, unknown>;
    data: { lastDeployedSha: string | null };
}) {
    const or = where.OR as { lastDeployedSha: null | { not: string } }[] | undefined;
    const matches = or
        ? or.some((clause) =>
              clause.lastDeployedSha === null
                  ? row.lastDeployedSha === null
                  : row.lastDeployedSha !== null &&
                    row.lastDeployedSha !== clause.lastDeployedSha.not
          )
        : row.lastDeployedSha === where.lastDeployedSha;
    if (!matches) return Promise.resolve({ count: 0 });
    row.lastDeployedSha = data.lastDeployedSha;
    return Promise.resolve({ count: 1 });
}

vi.mock("@polaris/db", () => ({
    prisma: { application: { findMany, updateMany: vi.fn(updateMany) } }
}));
vi.mock("@/lib/deploy-service", () => ({ deployApplication }));

const { deployPushedCommit, triggerAutoDeploysForPush } = await import("@/lib/deploy/push-deploys");

const COMMIT = { commitSha: "new", commitMessage: "docs: a push" };

beforeEach(() => {
    row.lastDeployedSha = "old";
    deployApplication.mockReset();
    deployApplication.mockResolvedValue("dep-1");
    findMany.mockReset();
});

describe("a pushed commit", () => {
    it("is deployed once when the webhook and the poller arrive together", async () => {
        // Both read the service before either wrote: that stale read is the race.
        const stale = { id: "app-1", lastDeployedSha: "old" };
        const answers = await Promise.all([
            deployPushedCommit(stale, "owner-1", COMMIT),
            deployPushedCommit(stale, "owner-1", COMMIT)
        ]);
        expect(answers.sort()).toEqual([false, true]);
        expect(deployApplication).toHaveBeenCalledTimes(1);
        expect(deployApplication).toHaveBeenCalledWith("app-1", "owner-1", "owner-1", {
            ...COMMIT,
            trigger: "push"
        });
        expect(row.lastDeployedSha).toBe("new");
    });

    it("is not deployed again by a redelivered webhook", async () => {
        row.lastDeployedSha = "new";
        expect(
            await deployPushedCommit({ id: "app-1", lastDeployedSha: "new" }, "owner-1", COMMIT)
        ).toBe(false);
        expect(deployApplication).not.toHaveBeenCalled();
    });

    it("is handed back when its deploy could not start, so the next poll retries it", async () => {
        deployApplication.mockRejectedValueOnce(new Error("the target is unreachable"));
        await expect(
            deployPushedCommit({ id: "app-1", lastDeployedSha: "old" }, "owner-1", COMMIT)
        ).rejects.toThrow("unreachable");
        expect(row.lastDeployedSha).toBe("old");
        expect(
            await deployPushedCommit({ id: "app-1", lastDeployedSha: "old" }, "owner-1", COMMIT)
        ).toBe(true);
        expect(deployApplication).toHaveBeenCalledTimes(2);
    });
});

describe("a webhook delivered twice", () => {
    it("starts one deploy between the two deliveries", async () => {
        findMany.mockResolvedValue([
            {
                id: "app-1",
                slug: "orphion",
                lastDeployedSha: "old",
                autoDeploy: true,
                sourceType: "dockerfile",
                sourceConfig: JSON.stringify({
                    repoUrl: "https://github.com/acme/shop",
                    branch: "main"
                }),
                deployBranch: "main",
                commitFilter: null,
                watchPaths: null,
                environment: { branch: null, project: { ownerId: "owner-1" } }
            }
        ]);
        const push = {
            repoFullName: "acme/shop",
            branch: "main",
            commitMessage: "docs: a push",
            commitSha: "new"
        };
        const started = await Promise.all([
            triggerAutoDeploysForPush(push),
            triggerAutoDeploysForPush(push)
        ]);
        expect(started.sort()).toEqual([0, 1]);
        expect(deployApplication).toHaveBeenCalledTimes(1);
    });
});
