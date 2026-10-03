/**
 * The Config screen's changes to the instance: a new password, statement
 * statistics, and a public port.
 *
 * Asserted: the engine is told the new password before it is stored, and told
 * the old one again if storing fails; only services whose variables name the
 * database restart (a shared variable reaches every running service); a
 * redeploy that fails is put back; and a port is refused before anything moves
 * when another database holds it or it sits in the services' range.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DB = "0192f1e2-7b5c-7d3e-8f00-00000000000a";

const state = vi.hoisted(() => ({
    runIn: vi.fn(async (_container: string, _argv: string[]) => ({ code: 0, output: "" })),
    update: vi.fn(async () => ({})),
    deployDatabaseAndWait: vi.fn(async () => null as string | null),
    findFirst: vi.fn(),
    applications: [] as { id: string; name: string }[],
    variables: [] as { scopeType: string; scopeId: string; isSecret: boolean; value: string }[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        managedDatabase: { findFirst: state.findFirst, update: state.update },
        application: { findMany: async () => state.applications },
        envVar: { findMany: async () => state.variables }
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "unused" }) }));
vi.mock("@polaris/storage", () => ({
    encryptCredentials: () => ({
        ciphertext: Buffer.from("c"),
        nonce: Buffer.from("n"),
        keyId: "k"
    })
}));
vi.mock("@/lib/database-service", () => ({ deployDatabaseAndWait: state.deployDatabaseAndWait }));
vi.mock("@/lib/deploy/env-values", () => ({
    decryptedValue: (row: { value: string }) => row.value
}));
vi.mock("@/lib/data/open", () => ({ withDriver: vi.fn(async () => undefined) }));
vi.mock("@/lib/data/connections", () => ({
    managedAddress: vi.fn(async () => ({ engine: "postgres" }))
}));
vi.mock("@/lib/data/maintenance", () => ({
    installExtension: vi.fn(),
    uninstallExtension: vi.fn()
}));
vi.mock("@/lib/database-ops/ops", async (original) => {
    const real = await original<typeof import("@/lib/database-ops/ops")>();
    return {
        ...real,
        instanceContext: vi.fn(async () => ({
            id: DB,
            name: "shop",
            slug: "shop",
            engine: "postgres",
            version: "16",
            ownerId: "owner-1",
            target: {},
            container: "shop-pg",
            own: { username: "polaris", password: "old-password-0123456789", database: "shop" },
            admin: { username: "polaris", password: "old-password-0123456789", database: "shop" },
            hosted: false,
            privileges: "owner",
            cluster: null,
            topology: { kind: "single" },
            mongoSeeds: null
        })),
        withPorts: async (_context: unknown, work: (ports: unknown) => Promise<unknown>) =>
            work({ runIn: state.runIn })
    };
});

const ops = await import("@/lib/database-ops/ops");
const admin = await import("@/lib/database-ops/admin");

beforeEach(() => {
    state.runIn.mockClear();
    state.update.mockReset();
    state.update.mockImplementation(async () => ({}));
    state.deployDatabaseAndWait.mockReset();
    state.deployDatabaseAndWait.mockImplementation(async () => null);
    state.findFirst.mockReset();
    state.applications = [];
    state.variables = [];
});

describe("a new password", () => {
    it("is set in the engine, then stored, and restarts only the services that read it", async () => {
        state.findFirst.mockResolvedValue({ environmentId: "env-1", slug: "shop", name: "Shop" });
        state.applications = [
            { id: "app-1", name: "api" },
            { id: "app-2", name: "web" }
        ];
        state.variables = [
            {
                scopeType: "application",
                scopeId: "app-1",
                isSecret: true,
                value: "${{shop.DATABASE_URL}}"
            },
            {
                scopeType: "application",
                scopeId: "app-2",
                isSecret: false,
                value: "${{other.DATABASE_URL}}"
            }
        ];
        const restart = vi.fn();
        const restarted = await admin.regeneratePassword(DB, "owner-1", "member-1", restart);
        const argv = state.runIn.mock.calls[0]?.[1] ?? [];
        expect(argv.slice(0, 7)).toEqual([
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "polaris",
            "-d",
            "postgres"
        ]);
        expect(argv.at(-1)).toMatch(/^ALTER ROLE "polaris" WITH PASSWORD '[A-Za-z0-9_-]{32}'$/);
        expect(state.update).toHaveBeenCalledTimes(1);
        expect(restarted).toEqual([{ id: "app-1", name: "api" }]);
        expect(restart).toHaveBeenCalledWith(["app-1"]);
    });

    it("reaches every running service when a shared variable names it", async () => {
        state.findFirst.mockResolvedValue({ environmentId: "env-1", slug: "shop", name: "Shop" });
        state.applications = [
            { id: "app-1", name: "api" },
            { id: "app-2", name: "web" }
        ];
        state.variables = [
            {
                scopeType: "environment",
                scopeId: "env-1",
                isSecret: false,
                value: "${{Shop.PGHOST}}"
            }
        ];
        expect((await admin.dependentServices(DB, "owner-1")).map((service) => service.id)).toEqual(
            ["app-1", "app-2"]
        );
    });

    it("sets and stores one change before the next one starts", async () => {
        state.findFirst.mockResolvedValue({ environmentId: "env-1", slug: "shop", name: "Shop" });
        const order: string[] = [];
        state.runIn.mockImplementation(async () => {
            order.push("engine");
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { code: 0, output: "" };
        });
        state.update.mockImplementation(async () => {
            order.push("stored");
            return {};
        });
        await Promise.all([
            admin.regeneratePassword(DB, "owner-1", "member-1", vi.fn()),
            admin.regeneratePassword(DB, "owner-1", "member-1", vi.fn())
        ]);
        expect(order).toEqual(["engine", "stored", "engine", "stored"]);
        state.runIn.mockImplementation(async () => ({ code: 0, output: "" }));
    });

    it("puts the old password back in the engine when it cannot be stored", async () => {
        state.update.mockRejectedValueOnce(new Error("database is down"));
        await expect(admin.regeneratePassword(DB, "owner-1", "member-1", vi.fn())).rejects.toThrow(
            "database is down"
        );
        expect(state.runIn).toHaveBeenCalledTimes(2);
        expect(state.runIn.mock.calls[1]?.[1].at(-1)).toBe(
            `ALTER ROLE "polaris" WITH PASSWORD 'old-password-0123456789'`
        );
    });

    it("starts a Redis container again on the new password, so a restart does not bring the old one back", async () => {
        state.findFirst.mockResolvedValue({ environmentId: "env-1", slug: "cache", name: "Cache" });
        const base = await vi.mocked(ops.instanceContext)(DB, "owner-1");
        vi.mocked(ops.instanceContext).mockResolvedValueOnce({
            ...base,
            engine: "redis",
            container: "cache-redis"
        });
        await admin.regeneratePassword(DB, "owner-1", "member-1", vi.fn());
        expect(state.runIn.mock.calls[0]?.[1].slice(-3)).toEqual([
            "SET",
            "requirepass",
            expect.any(String)
        ]);
        expect(state.update).toHaveBeenCalledTimes(1);
        expect(state.deployDatabaseAndWait).toHaveBeenCalledWith(DB, "owner-1", "member-1");
    });

    it("stores the old Redis password again when the container does not come back on the new one", async () => {
        state.findFirst.mockResolvedValue({ environmentId: "env-1", slug: "cache", name: "Cache" });
        const base = await vi.mocked(ops.instanceContext)(DB, "owner-1");
        vi.mocked(ops.instanceContext).mockResolvedValueOnce({
            ...base,
            engine: "redis",
            container: "cache-redis"
        });
        state.deployDatabaseAndWait.mockResolvedValueOnce("the deploy ended failed");
        await expect(admin.regeneratePassword(DB, "owner-1", "member-1", vi.fn())).rejects.toThrow(
            /put back/
        );
        expect(state.update).toHaveBeenCalledTimes(2);
        expect(state.deployDatabaseAndWait).toHaveBeenCalledTimes(2);
    });

    it("does not redeploy a PostgreSQL instance for a new password", async () => {
        state.findFirst.mockResolvedValue({ environmentId: "env-1", slug: "shop", name: "Shop" });
        await admin.regeneratePassword(DB, "owner-1", "member-1", vi.fn());
        expect(state.deployDatabaseAndWait).not.toHaveBeenCalled();
    });
});

describe("statement statistics", () => {
    it("puts the instance back when it does not start with the library loaded", async () => {
        state.findFirst.mockResolvedValue({
            id: DB,
            engine: "postgres",
            parentId: null,
            containerName: "shop-pg",
            statStatements: false
        });
        state.deployDatabaseAndWait.mockResolvedValueOnce("the deploy ended failed");
        await expect(admin.setStatStatements(DB, "owner-1", "member-1", true)).rejects.toThrow(
            /put back/
        );
        expect(state.update).toHaveBeenNthCalledWith(1, {
            where: { id: DB },
            data: { statStatements: true }
        });
        expect(state.update).toHaveBeenNthCalledWith(2, {
            where: { id: DB },
            data: { statStatements: false }
        });
        expect(state.deployDatabaseAndWait).toHaveBeenCalledTimes(2);
    });

    it("is refused on a database hosted inside another instance", async () => {
        state.findFirst.mockResolvedValue({
            id: DB,
            engine: "postgres",
            parentId: "parent",
            containerName: "",
            statStatements: false
        });
        await expect(admin.setStatStatements(DB, "owner-1", "member-1", true)).rejects.toThrow(
            /another instance/
        );
        expect(state.update).not.toHaveBeenCalled();
    });
});

describe("a public port", () => {
    it("refuses one in the services' range or held by another database, before changing anything", async () => {
        state.findFirst.mockResolvedValueOnce({
            id: DB,
            parentId: null,
            targetId: "t",
            exposePort: null,
            containerName: "c"
        });
        await expect(admin.setPublicPort(DB, "owner-1", "member-1", 25000)).rejects.toThrow(
            /kept for services/
        );
        state.findFirst
            .mockResolvedValueOnce({
                id: DB,
                parentId: null,
                targetId: "t",
                exposePort: null,
                containerName: "c"
            })
            .mockResolvedValueOnce({ id: "other" });
        await expect(admin.setPublicPort(DB, "owner-1", "member-1", 15432)).rejects.toThrow(
            /already uses that port/
        );
        expect(state.update).not.toHaveBeenCalled();
    });

    it("redeploys with the port, and puts it back if that fails", async () => {
        state.findFirst
            .mockResolvedValueOnce({
                id: DB,
                parentId: null,
                targetId: "t",
                exposePort: null,
                containerName: "c"
            })
            .mockResolvedValueOnce(null);
        state.deployDatabaseAndWait.mockResolvedValueOnce("port is already allocated");
        await expect(admin.setPublicPort(DB, "owner-1", "member-1", 15432)).rejects.toThrow(
            /put back/
        );
        expect(state.update).toHaveBeenNthCalledWith(2, {
            where: { id: DB },
            data: { exposePort: null }
        });
    });
});
