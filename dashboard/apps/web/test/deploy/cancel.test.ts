/**
 * Stopping a deploy that has not finished.
 *
 * The state this exists for is a build that wedges: nothing bounded one, so the
 * service sat in DEPLOYING until somebody restarted Polaris - and a restart left the
 * row saying DEPLOYING forever, because the queue that was driving it only ever lived
 * in that process's memory.
 *
 * So there are two independent halves and both are load-bearing. The row is settled
 * here, which is what clears a deploy whose runner no longer exists; and the abort is
 * signalled, which is what actually ends the work - the daemon streams the build
 * straight from the process it spawned and kills it when the connection goes away.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface DeploymentRow {
    status: string;
}

let found: DeploymentRow | null = null;
/** What is still in flight when the process comes back up. */
let inFlight: Array<{ id: string }> = [];
const updateMany = vi.fn(async () => ({ count: 1 }));
const deploymentUpdateMany = vi.fn(async (args: unknown) => {
    void args;
    return { count: 1 };
});
const notifyDeployFinished = vi.fn(async () => undefined);

vi.mock("@polaris/db", () => ({
    prisma: {
        deployment: {
            findFirst: vi.fn(async () => found),
            findUnique: vi.fn(async () => found),
            findMany: vi.fn(async () => inFlight),
            updateMany: deploymentUpdateMany
        },
        domain: { deleteMany: vi.fn(async () => ({ count: 0 })) }
    }
}));
vi.mock("@/lib/notifications/deploy-events", () => ({ notifyDeployFinished }));

const { cancelDeployment, recoverAbandonedDeployments } = await import("@/lib/deploy-service");
const { TERMINAL_DEPLOY_STATUSES } = await import("@/lib/deploy/status");

beforeEach(() => {
    found = { status: "deploying" };
    inFlight = [{ id: "dep-1" }, { id: "dep-2" }];
    deploymentUpdateMany.mockClear();
    deploymentUpdateMany.mockResolvedValue({ count: 1 });
    updateMany.mockClear();
    notifyDeployFinished.mockClear();
});

describe("cancelling a deploy", () => {
    it("settles a deployment whose runner died with an earlier process", async () => {
        // Nothing is registered to abort - this is the restart case, and it is the one
        // that used to have no way out at all.
        await cancelDeployment("dep-1", "owner-1");
        expect(deploymentUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) })
        );
    });

    it("never overwrites a deployment that has already reached a verdict", async () => {
        // The runner can be arriving at its own conclusion at the same moment, so the
        // write is conditional rather than a plain update; first one wins.
        await cancelDeployment("dep-1", "owner-1");
        const [args] = deploymentUpdateMany.mock.calls[0] as [{ where: { status: { notIn: string[] } } }];
        expect(args.where.status.notIn).toEqual(expect.arrayContaining(["running", "failed", "cancelled"]));
    });

    it("refuses a deploy that has already finished", async () => {
        found = { status: "failed" };
        await expect(cancelDeployment("dep-1", "owner-1")).rejects.toThrow(/already finished/i);
        expect(deploymentUpdateMany).not.toHaveBeenCalled();
    });

    it("refuses a deployment the caller does not own", async () => {
        // Scoped by the deploy target's owner, so whoever can watch a deploy is exactly
        // whoever can stop it.
        found = null;
        await expect(cancelDeployment("dep-1", "someone-else")).rejects.toThrow(/not found/i);
    });

    it("says so once, not twice, when the runner settles the same row after it", async () => {
        // The conditional write reports it changed nothing; announcing a failed deploy
        // again would read as two of them.
        deploymentUpdateMany.mockResolvedValue({ count: 0 });
        await cancelDeployment("dep-1", "owner-1");
        expect(notifyDeployFinished).not.toHaveBeenCalled();
    });
});

describe("recovering after a restart", () => {
    it("closes out whatever was still in flight, since nothing is driving it any more", async () => {
        await recoverAbandonedDeployments();
        const [args] = deploymentUpdateMany.mock.calls[0] as [
            { where: { id: { in: string[] } }; data: { status: string } }
        ];
        // Read first and updated by id, because the ids are needed afterwards: any of
        // these that reached GitHub is sitting in a repository reading "in progress",
        // and nothing else will ever move it off that.
        expect(args.where.id.in).toEqual(["dep-1", "dep-2"]);
        expect(args.data.status).toBe("failed");
    });

    it("writes nothing when nothing was in flight", async () => {
        inFlight = [];
        await recoverAbandonedDeployments();
        expect(deploymentUpdateMany).not.toHaveBeenCalled();
    });
});

describe("the terminal states", () => {
    it("holds every state a deployment stops moving in", () => {
        // Read by four separate decisions - whether a queued job still runs, whether a
        // verdict may be written, whether a screen keeps looking, what a card says the
        // service is doing - and they drifted apart when each kept its own copy.
        for (const status of ["running", "failed", "cancelled", "rolled_back", "stopped", "removed"]) {
            expect(TERMINAL_DEPLOY_STATUSES.has(status)).toBe(true);
        }
        for (const status of ["queued", "deploying"]) {
            expect(TERMINAL_DEPLOY_STATUSES.has(status)).toBe(false);
        }
    });
});
