/**
 * Deleting an app with its data removes its Docker volumes on whichever machine
 * it ran: this one through the daemon's checked route, another server over that
 * server's own connection. The database and the server are fakes - nothing is
 * run on a machine here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const APP = "00000000-0000-7000-8000-0000000000bb";
const OWNER = "00000000-0000-7000-8000-0000000000aa";
const TARGET = "00000000-0000-7000-8000-0000000000cc";

let targetKind = "host";

/** Every model answers nothing unless named here, so the delete can run through. */
const named: Record<string, Record<string, (...args: never[]) => Promise<unknown>>> = {
    application: {
        findFirst: async () => ({
            id: APP,
            environmentId: "env",
            volumes: [{ id: "vol-1" }],
            target: { id: TARGET, kind: targetKind }
        })
    },
    volume: {
        findMany: async () => [{ source: "data" }, { source: "config" }]
    },
    deployTarget: {
        findFirst: async () => ({ id: TARGET, kind: targetKind, hostId: "host-1", ownerId: OWNER })
    }
};
const prisma = new Proxy(
    {},
    {
        get: (_, model: string) =>
            new Proxy(
                {},
                {
                    get: (__, method: string) =>
                        named[model]?.[method] ??
                        (async () => (method.startsWith("findMany") ? [] : null))
                }
            )
    }
);
vi.mock("@polaris/db", () => ({ prisma }));

const removeVolume = vi.fn(async (_name: string) => undefined);
const ports = { removeVolume, dispose: vi.fn(async () => undefined) };
const getPorts = vi.fn(async () => ports);
vi.mock("@/lib/deploy/runtime", async (load) => ({
    ...(await load<typeof import("@/lib/deploy/runtime")>()),
    getPorts
}));
vi.mock("@/lib/deploy-project-service", () => ({
    getFlagsForEnvironment: async () => ({ wipeVolumesOnDelete: false })
}));
const wipeVolume = vi.fn(async () => undefined);
vi.mock("@/lib/deploy-volume-service", async (load) => ({
    ...(await load<object>()),
    wipeVolume
}));
const removeHostVolume = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/deploy/host-volumes", async (load) => ({
    ...(await load<object>()),
    removeHostVolume
}));

const { deleteApplication } = await import("@/lib/deploy-service");
const { appVolumeName } = await import("@/lib/deploy/host-resources");

const VOLUMES = [appVolumeName(APP, "data"), appVolumeName(APP, "config")];

beforeEach(() => {
    vi.clearAllMocks();
    targetKind = "host";
});

describe("deleting an app with its data", () => {
    it("removes its volumes on a server reached over SSH", async () => {
        await deleteApplication(APP, OWNER, { deleteData: true });
        expect(wipeVolume).toHaveBeenCalledWith("vol-1", OWNER);
        expect(removeVolume.mock.calls.map(([name]) => name)).toEqual(VOLUMES);
        // Emptied first, removed after.
        expect(wipeVolume.mock.invocationCallOrder[0]).toBeLessThan(
            removeVolume.mock.invocationCallOrder[0]!
        );
        expect(removeHostVolume).not.toHaveBeenCalled();
        expect(ports.dispose).toHaveBeenCalled();
    });

    it("keeps going when the server refuses one", async () => {
        removeVolume.mockRejectedValueOnce(new Error("volume is in use"));
        await expect(deleteApplication(APP, OWNER, { deleteData: true })).resolves.toBe(undefined);
        expect(removeVolume).toHaveBeenCalledTimes(2);
    });

    it("removes this machine's through the daemon, not over SSH", async () => {
        targetKind = "local";
        await deleteApplication(APP, OWNER, { deleteData: true });
        expect(removeHostVolume.mock.calls.map(([name]) => name)).toEqual(VOLUMES);
        expect(removeVolume).not.toHaveBeenCalled();
    });

    it("leaves every volume when the data is kept", async () => {
        await deleteApplication(APP, OWNER);
        expect(removeVolume).not.toHaveBeenCalled();
        expect(removeHostVolume).not.toHaveBeenCalled();
    });
});
