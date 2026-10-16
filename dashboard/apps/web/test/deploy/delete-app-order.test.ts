/**
 * Deleting an app takes it off the edge before it comes down, leaves every other
 * app's routes alone, touches no row when an uninstall's teardown fails, and
 * hands its release images to the sweep once nothing protects them. The
 * database, the edge files and the server are fakes - nothing runs on a machine.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const APP = "00000000-0000-7000-8000-0000000000bb";
const OWNER = "00000000-0000-7000-8000-0000000000aa";
const TARGET = "00000000-0000-7000-8000-0000000000cc";

const TUNNEL = {
    id: "00000000-0000-7000-8000-0000000000dd",
    hostname: "app.example.com",
    paused: false,
    publicTarget: {
        id: "t-edge",
        name: "edge-1",
        kind: "local",
        hostId: null,
        runtime: "compose",
        proxyNetwork: "p"
    },
    application: {
        id: APP,
        target: { id: TARGET, name: "home-box", kind: "local", hostId: null, runtime: "compose" }
    }
};

/** Every database call, in order, as `model.method` with its arguments. */
const calls: { readonly name: string; readonly args: unknown }[] = [];

const named: Record<string, Record<string, (...args: never[]) => Promise<unknown>>> = {
    application: {
        findFirst: async () => ({
            id: APP,
            environmentId: "env",
            volumes: [],
            target: { id: TARGET, kind: "local", hostId: null, runtime: "compose" }
        })
    }
};
const prisma = new Proxy(
    {},
    {
        get: (_, model: string) =>
            new Proxy(
                {},
                {
                    get: (__, method: string) => async (args: unknown) => {
                        calls.push({ name: `${model}.${method}`, args });
                        const own = named[model]?.[method];
                        if (own) return own();
                        return method.startsWith("findMany") ? [] : null;
                    }
                }
            )
    }
);
vi.mock("@polaris/db", () => ({ prisma }));

const getPorts = vi.fn(async () => {
    throw new Error("server unreachable");
});
vi.mock("@/lib/deploy/runtime", async (load) => ({
    ...(await load<typeof import("@/lib/deploy/runtime")>()),
    getPorts
}));
vi.mock("@/lib/deploy-project-service", () => ({
    getFlagsForEnvironment: async () => ({ wipeVolumesOnDelete: false })
}));
const writeDynamicFile = vi.fn(async () => undefined);
vi.mock("@/lib/traefik-dynamic", async (load) => ({
    ...(await load<object>()),
    writeDynamicFile
}));
const sweepReleaseImages = vi.fn(async () => []);
vi.mock("@/lib/deploy/release-retention", async (load) => ({
    ...(await load<typeof import("@/lib/deploy/release-retention")>()),
    sweepReleaseImages
}));

const { deleteApplication } = await import("@/lib/deploy-service");

function at(name: string): number {
    return calls.findIndex((call) => call.name === name);
}

beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
});

describe("deleting an app", () => {
    it("unroutes only its own domains, before its containers and rows go", async () => {
        await deleteApplication(APP, OWNER);
        const unroute = calls.filter((call) => call.name === "domain.updateMany");
        expect(unroute).toEqual([
            {
                name: "domain.updateMany",
                args: { where: { applicationId: APP }, data: { enabled: false } }
            }
        ]);
        // No other app's domain is written: the edge is rendered again from the rows.
        for (const call of calls.filter((one) => one.name.startsWith("domain."))) {
            if (call.name === "domain.findMany") continue;
            expect(JSON.stringify(call.args)).toContain(APP);
        }
        expect(at("domain.updateMany")).toBeGreaterThanOrEqual(0);
        expect(at("domain.updateMany")).toBeLessThan(at("deployment.deleteMany"));
        expect(at("deployment.deleteMany")).toBeLessThan(at("application.delete"));
    });

    it("hands its release images to the sweep on the machine it ran on", async () => {
        await deleteApplication(APP, OWNER);
        expect(sweepReleaseImages).toHaveBeenCalledWith("local");
    });

    it("strictly, stops before any row goes when its containers cannot come down", async () => {
        await expect(
            deleteApplication(APP, OWNER, { deleteData: true, strict: true })
        ).rejects.toBeInstanceOf(Error);
        expect(at("domain.updateMany")).toBeGreaterThanOrEqual(0);
        expect(at("deployment.deleteMany")).toBe(-1);
        expect(at("application.delete")).toBe(-1);
        expect(at("installedApp.updateMany")).toBe(-1);
        expect(sweepReleaseImages).not.toHaveBeenCalled();
    });

    it("strictly, routes its domains again when its containers cannot come down", async () => {
        named.domain = { findMany: async () => [{ id: "domain-1" }] };
        try {
            await expect(deleteApplication(APP, OWNER, { strict: true })).rejects.toThrow();
        } finally {
            delete named.domain;
        }
        const writes = calls.filter((call) => call.name === "domain.updateMany");
        expect(writes.map((call) => call.args)).toEqual([
            { where: { applicationId: APP }, data: { enabled: false } },
            { where: { id: { in: ["domain-1"] } }, data: { enabled: true } }
        ]);
    });

    it("leaves the installs the caller retires itself listed", async () => {
        getPorts.mockResolvedValueOnce({
            dispose: async () => undefined,
            down: async () => undefined
        } as never);
        await deleteApplication(APP, OWNER, { keepInstalls: ["install-1"] });
        const release = calls.find((call) => call.name === "installedApp.findMany");
        expect(release?.args).toMatchObject({
            where: { applicationId: APP, id: { notIn: ["install-1"] } }
        });
    });

    it("takes its tunnels down before the row that would cascade them goes", async () => {
        named.wireguardTunnel = { findMany: async () => [TUNNEL] };
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            await deleteApplication(APP, OWNER);
        } finally {
            delete named.wireguardTunnel;
            quiet.mockRestore();
        }
        const within = calls.find((call) => call.name === "wireguardTunnel.findMany");
        expect(within?.args).toMatchObject({ where: { ownerId: OWNER, applicationId: APP } });
        expect(at("wireguardTunnel.updateMany")).toBeGreaterThanOrEqual(0);
        expect(at("wireguardTunnel.updateMany")).toBeLessThan(at("application.delete"));
        expect(getPorts).toHaveBeenCalledWith(expect.objectContaining({ id: "t-edge" }), OWNER);
        expect(at("application.delete")).toBeGreaterThanOrEqual(0);
    });

    it("strictly, stops before any row goes when a tunnel end cannot be taken down", async () => {
        named.wireguardTunnel = { findMany: async () => [TUNNEL] };
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            await expect(deleteApplication(APP, OWNER, { strict: true })).rejects.toMatchObject({
                code: "leftover",
                params: { servers: "edge-1, home-box" }
            });
        } finally {
            delete named.wireguardTunnel;
            quiet.mockRestore();
        }
        expect(at("wireguardTunnel.deleteMany")).toBe(-1);
        expect(at("domain.updateMany")).toBe(-1);
        expect(at("application.delete")).toBe(-1);
    });

    it("strictly, asks for the same thing again on a retry", async () => {
        await deleteApplication(APP, OWNER, { strict: true }).catch(() => undefined);
        const first = calls.map((call) => call.name);
        calls.length = 0;
        await deleteApplication(APP, OWNER, { strict: true }).catch(() => undefined);
        expect(calls.map((call) => call.name)).toEqual(first);
    });
});
