/**
 * Copying data in from a connection saved in Databases - the one that reaches
 * a database through SSH included, with no terminal anywhere.
 *
 * The dump runs in the destination's container, which has the engine's tools;
 * the SSH tunnel is opened in the dashboard, which has the login. So the
 * tunnel is served on the network the two share, to that container's address
 * alone, and the dump dials it. What is pinned: the connection is read as its
 * owner reads it in Databases, a tunnel only goes to a destination on this
 * machine, the dump is pointed at the tunnel and not the far address, and the
 * tunnel is closed afterwards whatever happened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findConnection: vi.fn(),
    addressOf: vi.fn(),
    openTunnel: vi.fn(),
    closeTunnel: vi.fn(),
    runIn: vi.fn(),
    inspect: vi.fn(),
    restoreDumpInto: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    started: vi.fn(),
    target: { id: "t1", kind: "local", hostId: null, runtime: "compose", proxyNetwork: "polaris" }
}));

vi.mock("node:os", async (original) => ({
    ...(await original<typeof import("node:os")>()),
    networkInterfaces: () => ({
        eth0: [{ address: "172.18.0.4", netmask: "255.255.0.0", family: "IPv4", internal: false }]
    })
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        dataConnection: { findFirst: mocks.findConnection },
        protectedResource: { findFirst: async () => null }
    }
}));
vi.mock("@/lib/data/connections", () => ({ addressOf: mocks.addressOf }));
vi.mock("@/lib/data/tunnel", () => ({ openTunnel: mocks.openTunnel }));
vi.mock("@/lib/database-ops/restore", () => ({ restoreDumpInto: mocks.restoreDumpInto }));
vi.mock("@/lib/backups/sources/databases", () => ({
    dumpInContainer: vi.fn(),
    isDumpableEngine: () => true
}));
vi.mock("@/lib/database-ops/ops", async () => {
    class DatabaseOperationError extends Error {}
    return {
        DatabaseOperationError,
        instanceContext: async () => ({
            id: "db-into",
            name: "app-db",
            slug: "app-db",
            engine: "postgres",
            target: mocks.target,
            container: "polaris-app-db",
            cluster: null,
            topology: { kind: "single" }
        }),
        startOperation: async () => {
            mocks.started();
            return {
                id: "op-1",
                step: async () => undefined,
                progress: async () => undefined,
                succeed: mocks.succeed,
                fail: mocks.fail
            };
        },
        withPorts: async (_context: unknown, work: (ports: unknown) => Promise<unknown>) =>
            work({ runIn: mocks.runIn, inspect: mocks.inspect }),
        stagedPath: (id: string, ext: string) => `/tmp/${id}.${ext}`,
        unstage: async () => undefined,
        lastLine: (output: string) => output
    };
});

const { copyInto } = await import("@/lib/database-ops/copy");

const TUNNEL = { target: { host: "bastion.example.test", port: 22 }, jump: null, label: "bastion" };
const CONNECTION = "44444444-4444-4444-8444-444444444444";

function address(tunnel: unknown) {
    return {
        engine: "postgres",
        host: "127.0.0.1",
        port: 5432,
        database: "shop",
        username: "reader",
        password: "secret",
        tls: { mode: "disable", ca: null, clientCert: null, clientKey: null, name: null },
        readOnly: true,
        tunnel
    };
}

/** The copy runs on after `copyInto` answers; its progress is measured every
 *  few seconds, so the clock is moved on until it has finished. */
async function settled(): Promise<void> {
    for (let turn = 0; turn < 10; turn += 1) await vi.advanceTimersByTimeAsync(4000);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.target.kind = "local";
    mocks.findConnection.mockResolvedValue({ name: "Shop (prod)" });
    mocks.inspect.mockResolvedValue({
        NetworkSettings: { Networks: { polaris: { IPAddress: "172.18.0.9", IPPrefixLen: 16 } } }
    });
    mocks.openTunnel.mockResolvedValue({ host: "172.18.0.4", port: 40123, close: mocks.closeTunnel });
    mocks.runIn.mockResolvedValue({ code: 0, output: "" });
});

afterEach(() => {
    vi.useRealTimers();
});

describe("a copy from a saved connection behind SSH", () => {
    it("opens the tunnel for the destination's container alone and dumps through it", async () => {
        mocks.addressOf.mockResolvedValue(address(TUNNEL));
        await copyInto("db-into", "owner-1", "user-1", { fromConnectionId: CONNECTION });
        await settled();

        expect(mocks.findConnection).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: CONNECTION, ownerId: "user-1", managedDatabaseId: null } })
        );
        expect(mocks.addressOf).toHaveBeenCalledWith("user-1", CONNECTION);
        expect(mocks.openTunnel).toHaveBeenCalledWith(TUNNEL, "127.0.0.1", 5432, undefined, {
            bindHost: "172.18.0.4",
            allowFrom: "172.18.0.9"
        });
        const dump = mocks.runIn.mock.calls.find(([, argv]) => argv.join(" ").includes("pg_dump"));
        expect(dump?.[0]).toBe("polaris-app-db");
        // Dialled at the tunnel, never at the far side's own address.
        expect(dump?.[1]).toContain("172.18.0.4");
        expect(dump?.[1]).toContain("40123");
        expect(mocks.closeTunnel).toHaveBeenCalledTimes(1);
        expect(mocks.restoreDumpInto).toHaveBeenCalled();
        expect(mocks.succeed).toHaveBeenCalled();
    });

    it("closes the tunnel when the dump fails", async () => {
        mocks.addressOf.mockResolvedValue(address(TUNNEL));
        mocks.runIn.mockImplementation(async (_container: string, argv: string[]) =>
            argv.join(" ").includes("pg_dump") ? { code: 1, output: "connection refused" } : { code: 0, output: "0" }
        );
        await copyInto("db-into", "owner-1", "user-1", { fromConnectionId: CONNECTION });
        await settled();
        expect(mocks.closeTunnel).toHaveBeenCalledTimes(1);
        expect(mocks.fail).toHaveBeenCalled();
    });

    it("is refused, before anything starts, into a database on another server", async () => {
        mocks.target.kind = "ssh";
        mocks.addressOf.mockResolvedValue(address(TUNNEL));
        await expect(
            copyInto("db-into", "owner-1", "user-1", { fromConnectionId: CONNECTION })
        ).rejects.toThrow(/runs on another server/);
        expect(mocks.started).not.toHaveBeenCalled();
        expect(mocks.openTunnel).not.toHaveBeenCalled();
    });

    it("says so when the destination shares no network with Polaris", async () => {
        mocks.addressOf.mockResolvedValue(address(TUNNEL));
        mocks.inspect.mockResolvedValue({ NetworkSettings: { Networks: {} } });
        await copyInto("db-into", "owner-1", "user-1", { fromConnectionId: CONNECTION });
        await settled();
        expect(mocks.openTunnel).not.toHaveBeenCalled();
        expect(String(mocks.fail.mock.calls[0]?.[0])).toMatch(/not on a network Polaris can reach/);
    });
});

describe("a copy from a saved connection reached directly", () => {
    it("dumps from the destination's container with no tunnel", async () => {
        mocks.addressOf.mockResolvedValue({ ...address(null), host: "db.example.test" });
        await copyInto("db-into", "owner-1", "user-1", { fromConnectionId: CONNECTION });
        await settled();
        expect(mocks.openTunnel).not.toHaveBeenCalled();
        const dump = mocks.runIn.mock.calls.find(([, argv]) => argv.join(" ").includes("pg_dump"));
        expect(dump?.[1]).toContain("db.example.test");
    });

    it("is refused for somebody else's connection", async () => {
        mocks.findConnection.mockResolvedValue(null);
        await expect(
            copyInto("db-into", "owner-1", "user-1", { fromConnectionId: CONNECTION })
        ).rejects.toThrow(/not there any more/);
        expect(mocks.addressOf).not.toHaveBeenCalled();
    });
});
