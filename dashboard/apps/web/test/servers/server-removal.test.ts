/**
 * Taking a server out.
 *
 * The whole value of the "move" mode is an ordering: the service comes up on the
 * new server BEFORE it is taken down on the old one, and the old one is named
 * explicitly because the service is already pointing elsewhere by then. Get that
 * backwards and the feature is an outage with extra steps, so the order and the
 * target it stops are asserted rather than assumed.
 *
 * The other half is what happens when the far side refuses: the service goes back
 * to the server it came from, nothing is stopped, and the machine stays connected
 * so the operator has somewhere to retry from.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "018f2b7a-0000-7000-8000-0000000000a1";
const HOST = "018f2b7a-0000-7000-8000-0000000000b1";
const OTHER_HOST = "018f2b7a-0000-7000-8000-0000000000b2";
const OLD_TARGET = "018f2b7a-0000-7000-8000-0000000000c1";
const NEW_TARGET = "018f2b7a-0000-7000-8000-0000000000c2";
const APP = "018f2b7a-0000-7000-8000-0000000000d1";

const calls: string[] = [];

/** The applications table, as much of it as this behaviour depends on: which
 *  server a service is on, and whether it is currently running there. Both change
 *  as the move progresses, and the teardown that follows reads them again - a mock
 *  that answered every query the same way would hide that. */
interface AppRow {
    id: string;
    name: string;
    hostId: string;
    targetId: string;
    currentDeploymentId: string | null;
    environment: { project: { name: string } };
}
let appRows: AppRow[] = [];

const hostFindFirst = vi.fn();
const hostFindMany = vi.fn(async () => []);
const applicationFindMany = vi.fn(async (args?: { where?: Record<string, any> }) => {
    const where = args?.where ?? {};
    return appRows.filter(
        (row) =>
            (where.target?.hostId === undefined || row.hostId === where.target.hostId) &&
            (where.currentDeploymentId === undefined || row.currentDeploymentId !== null)
    );
});
const applicationUpdate = vi.fn(async (args: { where: { id: string }; data: { targetId: string } }) => {
    const row = appRows.find((entry) => entry.id === args.where.id);
    if (row) {
        row.targetId = args.data.targetId;
        row.hostId = args.data.targetId === NEW_TARGET ? OTHER_HOST : HOST;
    }
    return args;
});
const volumeUpdateMany = vi.fn(async (args: unknown) => args);
const volumeCount = vi.fn(async () => 0);
const runnerPoolCount = vi.fn(async () => 0);
const enrollmentFindFirst = vi.fn(async () => null);
const deleteHost = vi.fn(async () => undefined);
const deployAndWait = vi.fn(async () => null as string | null);
const stopApplicationOnTarget = vi.fn(async () => undefined);
const getHostConnection = vi.fn(async () => {
    throw new Error("not reachable in this test");
});

vi.mock("@polaris/db", () => ({
    prisma: {
        host: { findFirst: hostFindFirst, findMany: hostFindMany },
        application: { findMany: applicationFindMany, update: applicationUpdate },
        volume: { updateMany: volumeUpdateMany, count: volumeCount },
        runnerPool: { count: runnerPoolCount },
        enrollment: { findFirst: enrollmentFindFirst },
        $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations)
    }
}));
vi.mock("@polaris/ssh", () => ({ execCommand: vi.fn(), openSshClient: vi.fn() }));
vi.mock("@/lib/host-service", () => ({ deleteHost, getHostConnection }));
vi.mock("@/lib/deploy-target-service", () => ({
    getOrCreateLocalTarget: async () => ({ id: NEW_TARGET }),
    getOrCreateHostTarget: async () => ({ id: NEW_TARGET })
}));
vi.mock("@/lib/deploy-service", () => ({
    deployAndWait: (...args: unknown[]) => {
        calls.push("deploy");
        return deployAndWait(...(args as []));
    },
    stopApplicationOnTarget: (...args: unknown[]) => {
        calls.push("stop");
        return stopApplicationOnTarget(...(args as []));
    },
    syncAppRoutes: async () => undefined
}));

const { getServerRemovalPlan, removeServer } = await import("../../src/lib/server-removal-service");

/** One service on the server being removed, running there or merely configured. */
function oneService(name: string, deployed: boolean) {
    appRows = [
        {
            id: APP,
            name,
            hostId: HOST,
            targetId: OLD_TARGET,
            currentDeploymentId: deployed ? "dep-1" : null,
            environment: { project: { name: "home" } }
        }
    ];
}

describe("removing a server", () => {
    beforeEach(() => {
        calls.length = 0;
        vi.clearAllMocks();
        hostFindFirst.mockResolvedValue({ id: HOST, name: "lirio-1", username: "polaris", sudo: false });
        hostFindMany.mockResolvedValue([]);
        appRows = [];
        deployAndWait.mockResolvedValue(null);
        enrollmentFindFirst.mockResolvedValue(null);
    });

    it("only forgets the machine when that is what was asked", async () => {
        oneService("api", true);
        const result = await removeServer(OWNER, HOST, OWNER, { mode: "disconnect" });
        expect(result.error).toBeUndefined();
        expect(calls).toEqual([]);
        expect(deleteHost).toHaveBeenCalledWith(OWNER, HOST);
    });

    it("brings the service up on the new server before stopping the old one", async () => {
        oneService("api", true);
        const result = await removeServer(OWNER, HOST, OWNER, { mode: "move", destinationId: OTHER_HOST });

        expect(result.error).toBeUndefined();
        expect(result.moved).toEqual(["api"]);
        // The deploy comes first, and the teardown names the server it came from -
        // by then the service itself points at the new one.
        expect(calls[0]).toBe("deploy");
        expect(calls).toContain("stop");
        expect(calls.indexOf("deploy")).toBeLessThan(calls.indexOf("stop"));
        expect(stopApplicationOnTarget).toHaveBeenCalledWith(APP, OWNER, OLD_TARGET);
        expect(applicationUpdate).toHaveBeenCalledWith({ where: { id: APP }, data: { targetId: NEW_TARGET } });
        expect(deleteHost).toHaveBeenCalled();
    });

    it("puts the service back and keeps the server when the new one refuses it", async () => {
        oneService("api", true);
        deployAndWait.mockResolvedValue("image not found");

        const result = await removeServer(OWNER, HOST, OWNER, { mode: "move", destinationId: OTHER_HOST });

        expect(result.error).toContain("api");
        expect(result.error).toContain("image not found");
        expect(stopApplicationOnTarget).not.toHaveBeenCalled();
        expect(applicationUpdate).toHaveBeenLastCalledWith({ where: { id: APP }, data: { targetId: OLD_TARGET } });
        expect(deleteHost).not.toHaveBeenCalled();
    });

    it("retargets a service that was not running without deploying it", async () => {
        oneService("worker", false);
        const result = await removeServer(OWNER, HOST, OWNER, { mode: "move", destinationId: OTHER_HOST });
        expect(result.moved).toEqual(["worker"]);
        expect(calls).toEqual([]);
    });

    it("refuses a move with nowhere to move to", async () => {
        const result = await removeServer(OWNER, HOST, OWNER, { mode: "move" });
        expect(result.error).toBeTruthy();
        expect(deleteHost).not.toHaveBeenCalled();
    });

    it("reports what is at stake before anything is destroyed", async () => {
        oneService("api", true);
        volumeCount.mockResolvedValue(2);
        hostFindMany.mockResolvedValue([{ id: OTHER_HOST, name: "lirio-2" }]);

        const plan = await getServerRemovalPlan(OWNER, HOST);

        expect(plan?.services).toEqual([{ id: APP, name: "api", project: "home", deployed: true }]);
        expect(plan?.localVolumes).toBe(2);
        // The local box is always an option, so a single-server setup can still pull
        // everything back off a machine it is giving up.
        expect(plan?.destinations.map((entry) => entry.id)).toEqual(["local", OTHER_HOST]);
    });
});
