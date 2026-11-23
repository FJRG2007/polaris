/**
 * The one-time offer to close the environments made before private networking.
 *
 * What it rests on: an installed app's project is never offered (its stack's
 * routers dial it on the shared network), nothing is touched that the owner was
 * not shown, the offer is taken once however many times it is clicked, and a
 * database is back on its new network before the services that use it restart.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const environmentFindMany = vi.fn();
const environmentFindFirst = vi.fn();
const environmentUpdate = vi.fn(async () => ({}));
vi.mock("@polaris/db", () => ({
    prisma: {
        environment: {
            findMany: environmentFindMany,
            findFirst: environmentFindFirst,
            update: environmentUpdate
        }
    }
}));

const settings = new Map<string, string>();
vi.mock("@/lib/setting-store", () => ({
    getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
    swapSetting: vi.fn(async (key: string, expected: string | null, value: string) => {
        if ((settings.get(key) ?? null) !== expected) return false;
        settings.set(key, value);
        return true;
    }),
    setSetting: vi.fn(async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    })
}));

vi.mock("@/lib/deploy/managed-projects", () => ({
    polarisProjectIds: vi.fn(async () => new Set(["project-marketplace"]))
}));

let privateNetworks = true;
vi.mock("@polaris/config", () => ({ getCapabilities: () => ({ privateNetworks }) }));

const calls: string[] = [];
vi.mock("@/lib/database-service", () => ({
    deployDatabaseAndWait: vi.fn(async (id: string) => {
        calls.push(`db:${id}`);
        return null;
    })
}));
vi.mock("@/lib/deploy-service", () => ({
    restartFromKeptImage: vi.fn(async (id: string) => {
        calls.push(`app:${id}`);
        return "deployment";
    })
}));

const isolation = await import("@/lib/deploy/network-isolation");
const { restartFromKeptImage } = await import("@/lib/deploy-service");

const SHARED = {
    id: "env-shared",
    name: "production",
    networkMode: "shared",
    project: { id: "project-a", name: "Shop" },
    databases: [{ name: "postgres" }],
    applications: [{ name: "web" }, { name: "worker" }],
    _count: { databases: 1, applications: 11 }
};
const PRIVATE = {
    id: "env-private",
    name: "staging",
    networkMode: "environment",
    project: { id: "project-b", name: "Blog" },
    databases: [{ name: "mysql" }],
    applications: [{ name: "site" }, { name: "cron" }],
    _count: { databases: 1, applications: 2 }
};

beforeEach(() => {
    settings.clear();
    calls.length = 0;
    privateNetworks = true;
    environmentFindMany.mockReset();
    environmentFindFirst.mockReset();
    environmentUpdate.mockClear();
    vi.mocked(restartFromKeptImage).mockClear();
    environmentFindMany.mockImplementation(async (args: { where: { id?: unknown } }) =>
        args.where.id
            ? [{ id: "env-private", applications: [{ name: "site" }], _count: { applications: 1 } }]
            : [SHARED, PRIVATE]
    );
});

describe("what the offer lists", () => {
    it("leaves out installed apps' projects and other owners' projects", async () => {
        await isolation.reviewNetworkIsolation("owner-1");
        const where = environmentFindMany.mock.calls[0]![0].where;
        expect(where.project).toEqual({ ownerId: "owner-1", id: { notIn: ["project-marketplace"] } });
    });

    it("isolates a shared environment and restarts everything running in it, databases first", async () => {
        const review = await isolation.reviewNetworkIsolation("owner-1");
        const shared = review.environments.find((one) => one.id === "env-shared")!;
        expect(shared.change).toBe("isolate");
        expect(shared.restarts).toEqual(["postgres", "web", "worker"]);
        expect(shared.moreRestarts).toBe(9);
    });

    it("restarts only the routed services of an environment that is already private", async () => {
        const review = await isolation.reviewNetworkIsolation("owner-1");
        const own = review.environments.find((one) => one.id === "env-private")!;
        expect(own.change).toBe("restart");
        expect(own.restarts).toEqual(["site"]);
        expect(own.moreRestarts).toBe(0);
    });

    it("is not made again once the owner has answered", async () => {
        await isolation.keepNetworksAsTheyAre("owner-1");
        const review = await isolation.reviewNetworkIsolation("owner-1");
        expect(review.settledAt).not.toBeNull();
        expect(review.environments).toEqual([]);
        expect(environmentFindMany).not.toHaveBeenCalled();
    });
});

describe("taking the offer", () => {
    beforeEach(() => {
        environmentFindFirst.mockImplementation(async (args: { where: { id: string } }) =>
            args.where.id === "env-shared"
                ? {
                      networkMode: "shared",
                      databases: [{ id: "db-1" }],
                      applications: [{ id: "app-1" }, { id: "app-2" }]
                  }
                : { networkMode: "environment", databases: [{ id: "db-2" }], applications: [{ id: "app-3" }] }
        );
    });

    it("touches only environments that were offered, and switches only the shared one", async () => {
        const plans = await isolation.applyNetworkIsolation("owner-1", [
            "env-shared",
            "env-private",
            "env-someone-else"
        ]);
        expect(plans?.map((plan) => plan.environmentId)).toEqual(["env-shared", "env-private"]);
        expect(environmentUpdate).toHaveBeenCalledTimes(1);
        expect(environmentUpdate).toHaveBeenCalledWith({
            where: { id: "env-shared" },
            data: { networkMode: "environment" }
        });
        const own = plans!.find((plan) => plan.environmentId === "env-private")!;
        expect(own.databaseIds).toEqual([]);
        expect(own.applicationIds).toEqual(["app-3"]);
    });

    it("is taken once: a second click changes nothing", async () => {
        expect(await isolation.applyNetworkIsolation("owner-1", ["env-shared"])).not.toBeNull();
        environmentUpdate.mockClear();
        expect(await isolation.applyNetworkIsolation("owner-1", ["env-shared"])).toBeNull();
        expect(environmentUpdate).not.toHaveBeenCalled();
    });

    it("refuses on a machine that cannot hold private networks, and leaves the offer standing", async () => {
        privateNetworks = false;
        await expect(isolation.applyNetworkIsolation("owner-1", ["env-shared"])).rejects.toThrow();
        expect(environmentUpdate).not.toHaveBeenCalled();
        expect(settings.size).toBe(0);
    });

    it("leaves the offer standing when a switch fails", async () => {
        environmentUpdate.mockRejectedValueOnce(new Error("database gone"));
        await expect(isolation.applyNetworkIsolation("owner-1", ["env-shared"])).rejects.toThrow();
        expect(settings.size).toBe(0);
    });

    it("brings each database back before the services that use it, from their kept images", async () => {
        const plans = await isolation.applyNetworkIsolation("owner-1", ["env-shared", "env-private"]);
        await isolation.restartForIsolation(plans!, "owner-1", "actor-1");
        expect(calls).toEqual(["db:db-1", "app:app-1", "app:app-2", "app:app-3"]);
        expect(restartFromKeptImage).toHaveBeenCalledWith("app-1", "owner-1", "actor-1", "settings", {
            reason: "isolation"
        });
    });
});
