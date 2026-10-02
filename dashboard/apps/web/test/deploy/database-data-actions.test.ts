/**
 * A Deploy database's Database tab, at the action boundary.
 *
 * What has to hold: every call is gated on `databases.manage` for that database
 * and acts as the project's owner; the panel's Read-only switch can only narrow
 * (it becomes the driver's read-only flag, never a way round it); a malformed
 * body never reaches a driver; writes and admin changes are on the audit trail;
 * and a new password restarts exactly the services that read it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DB = "0192f1e2-7b5c-7d3e-8f00-00000000000a";

const mocks = vi.hoisted(() => ({
    requirePermission: vi.fn(async () => ({ id: "member-1" })),
    requireDatabaseAccess: vi.fn(async () => ({ ownerId: "owner-1", environmentId: "env-1" })),
    managedAddress: vi.fn(async (_owner: string, _id: string, readOnly: boolean) => ({
        engine: "postgres",
        host: "db",
        port: 5432,
        tls: false,
        readOnly
    })),
    browseAt: vi.fn(async () => ({ shape: "sql", namespaces: [], relations: [], namespace: "public" })),
    insertRowAt: vi.fn(async () => ({ changed: 1 })),
    deleteRowsAt: vi.fn(async () => ({ changed: 2 })),
    runAt: vi.fn(async () => [{ statement: "x", columns: [], rows: [], affected: 3, ms: 1 }]),
    recordDeployAudit: vi.fn(async () => undefined),
    regeneratePassword: vi.fn(),
    redeployForEnvScope: vi.fn(async () => undefined)
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ unstable_rethrow: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/lib/deploy-project-access", () => ({ requireDatabaseAccess: mocks.requireDatabaseAccess }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/data/connections", () => ({
    managedAddress: mocks.managedAddress,
    DataConnectionError: class DataConnectionError extends Error {}
}));
vi.mock("@/lib/data/browser", () => ({
    browseAt: mocks.browseAt,
    insertRowAt: mocks.insertRowAt,
    deleteRowsAt: mocks.deleteRowsAt,
    runAt: mocks.runAt
}));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit: mocks.recordDeployAudit }));
vi.mock("@/lib/deploy-service", () => ({ redeployForEnvScope: mocks.redeployForEnvScope }));
vi.mock("@/lib/database-ops/admin", () => ({ regeneratePassword: mocks.regeneratePassword }));
vi.mock("@/lib/database-ops/ops", () => ({ DatabaseOperationError: class DatabaseOperationError extends Error {} }));
vi.mock("@/lib/data/open", () => ({ withDriver: vi.fn() }));
vi.mock("@/lib/data/stats", () => ({ engineStatsAt: vi.fn() }));
vi.mock("@/lib/data/insights", () => ({ databaseInsightsAt: vi.fn() }));
vi.mock("@/lib/data/maintenance", () => ({}));
vi.mock("@/lib/domain-service", () => ({ getPublicIp: vi.fn() }));
vi.mock("@/lib/database-service", () => ({ databaseConnection: vi.fn() }));
vi.mock("@polaris/db", () => ({ prisma: {} }));

const actions = await import("@/app/(app)/apps/deploy/database-data-actions");

beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
});

describe("reading", () => {
    it("is gated on deploy.manage and databases.manage and opens read-only while the switch is on", async () => {
        const result = await actions.managedBrowseAction({ databaseId: DB, writable: false }, null);
        expect(result.error).toBeUndefined();
        expect(mocks.requirePermission).toHaveBeenCalledWith("deploy.manage");
        expect(mocks.requireDatabaseAccess).toHaveBeenCalledWith(DB, "member-1", "databases.manage");
        expect(mocks.managedAddress).toHaveBeenCalledWith("owner-1", DB, true);
    });

    it("stops at the gate: no address is resolved and no driver is touched", async () => {
        mocks.requireDatabaseAccess.mockRejectedValueOnce(new Error("Database not found"));
        const result = await actions.managedBrowseAction({ databaseId: DB, writable: false }, null);
        expect(result.error).toBe("refusals.databaseNotFound");
        expect(mocks.managedAddress).not.toHaveBeenCalled();
        expect(mocks.browseAt).not.toHaveBeenCalled();
    });

    it("refuses a database id that is not one", async () => {
        const result = await actions.managedBrowseAction({ databaseId: "../etc", writable: false }, null);
        expect(result.error).toBeDefined();
        expect(mocks.requireDatabaseAccess).not.toHaveBeenCalled();
    });
});

describe("writing", () => {
    it("opens writable only when asked, and records the row added", async () => {
        const result = await actions.managedInsertRowAction(
            { databaseId: DB, writable: true },
            { namespace: "public", relation: "users", values: { email: "a@b.c" } }
        );
        expect(result).toEqual({ changed: 1 });
        expect(mocks.managedAddress).toHaveBeenCalledWith("owner-1", DB, false);
        expect(mocks.recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "deploy.db.row.insert", targetId: DB, metadata: { table: "users" } })
        );
    });

    it("never hands a malformed body to a driver", async () => {
        const result = await actions.managedDeleteRowsAction({ databaseId: DB, writable: true }, { relation: "users", keys: [] });
        expect(result.error).toBeDefined();
        expect(mocks.deleteRowsAt).not.toHaveBeenCalled();
        const created = await actions.managedCreateTableAction(
            { databaseId: DB, writable: true },
            { namespace: null, name: "users; DROP", columns: [] }
        );
        expect(created.error).toBe("refusals.tableName");
    });

    it("records that a writing statement ran, never what it said", async () => {
        await actions.managedRunAction({ databaseId: DB, writable: true }, "UPDATE users SET password = 'hunter2'");
        const entry = mocks.recordDeployAudit.mock.calls.at(-1)?.[0] as { metadata: unknown } | undefined;
        expect(entry?.metadata).toEqual({ statements: 1 });
        expect(JSON.stringify(entry)).not.toContain("hunter2");
    });
});

describe("a new password", () => {
    it("restarts each service that reads it and records which", async () => {
        mocks.regeneratePassword.mockImplementationOnce(async (_id: string, _owner: string, restart: (ids: string[]) => void) => {
            restart(["app-1", "app-2"]);
            return [
                { id: "app-1", name: "api" },
                { id: "app-2", name: "worker" }
            ];
        });
        const result = await actions.regeneratePasswordAction(DB);
        expect(result.restarted?.map((service) => service.name)).toEqual(["api", "worker"]);
        expect(mocks.redeployForEnvScope).toHaveBeenCalledTimes(2);
        expect(mocks.redeployForEnvScope).toHaveBeenCalledWith("application", "app-1", "owner-1", "member-1", expect.anything());
        expect(mocks.recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "deploy.db.password.regenerate", metadata: { restarted: ["app-1", "app-2"] } })
        );
    });
});
