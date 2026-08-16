/**
 * What the database browser offers before anybody has saved anything.
 *
 * The point of the list is that Polaris already knows these: a database it runs
 * for this account, and its own for whoever runs the instance. So the cases here
 * are the ones that decide whether that is safe - a database is offered once
 * rather than twice, Polaris' own is behind `system.manage` and never behind the
 * permission that merely opens the app, and an offered id resolves to a real
 * address only after the question behind it has been asked again.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";
const DB = "aaaaaaaa-1111-4111-8111-111111111111";

/** The saved connections this account has. */
let saved: Record<string, unknown>[] = [];
/** The databases Polaris runs for it. */
let managed: Record<string, unknown>[] = [];
/** What `can` answers for `system.manage`. */
let runsTheInstance = false;
let provider: "postgresql" | "sqlite" = "postgresql";
let databaseUrl = "postgresql://polaris:secret@postgres:5432/polaris";

vi.mock("@polaris/db", () => ({
    prisma: {
        dataConnection: {
            findMany: async () => saved,
            findFirst: async ({ where }: { where: { id: string } }) =>
                saved.find((row) => row.id === where.id) ?? null
        },
        managedDatabase: {
            findMany: async () => managed,
            findFirst: async ({ where }: { where: { id: string } }) =>
                managed.find((row) => row.id === where.id) ?? null
        }
    }
}));
vi.mock("@polaris/config", () => ({
    loadEnv: () => ({
        POLARIS_DB_PROVIDER: provider,
        POLARIS_DATABASE_URL: databaseUrl,
        POLARIS_MASTER_KEY: "0".repeat(64)
    })
}));
vi.mock("@polaris/auth", () => ({
    userHasPermission: async (_userId: string, permission: string) =>
        permission === "system.manage" && runsTheInstance
}));
vi.mock("@polaris/storage", () => ({
    encryptCredentials: () => ({ ciphertext: Buffer.from(""), nonce: Buffer.from(""), keyId: "k" }),
    decryptCredentials: () => ({ password: "stored" })
}));
vi.mock("@/lib/database-service", () => ({
    databaseCredentials: async () => ({ username: "app", password: "app-secret", database: "app" })
}));

const { addressOf, listOpenable } = await import("@/lib/data/connections");

/** A database Polaris runs, on the machine Polaris runs on. */
function managedRow(overrides: Record<string, unknown> = {}) {
    return {
        id: DB,
        name: "app",
        engine: "postgres",
        containerName: "polaris-app-db",
        exposePort: null,
        environment: { name: "production", project: { name: "shop" } },
        parent: null,
        target: { name: "local", kind: "local", host: null },
        ...overrides
    };
}

beforeEach(() => {
    saved = [];
    managed = [];
    runsTheInstance = false;
    provider = "postgresql";
    databaseUrl = "postgresql://polaris:secret@postgres:5432/polaris";
});

describe("what the browser lists", () => {
    it("offers a database Polaris runs without anything having been saved", async () => {
        managed = [managedRow()];

        const list = await listOpenable(ALICE);

        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            id: `managed:${DB}`,
            name: "app",
            origin: "managed",
            managedDatabaseId: DB,
            where: "shop / production",
            readOnly: true,
            note: null
        });
    });

    it("says so rather than hiding one it cannot reach from here", async () => {
        managed = [
            managedRow({
                exposePort: null,
                target: { name: "edge", kind: "remote", host: { address: "10.0.0.4" } }
            })
        ];

        const [entry] = await listOpenable(ALICE);

        expect(entry.note).toContain("not published on a port");
    });

    it("lists a database a saved connection already points at once", async () => {
        managed = [managedRow()];
        saved = [
            {
                id: "conn-1",
                name: "Shop production",
                engine: "postgres",
                managedDatabaseId: DB,
                managed: { name: "app", engine: "postgres" },
                host: null,
                port: null,
                database: null,
                username: null,
                readOnly: false,
                tls: false,
                lastUsedAt: null,
                createdAt: new Date("2026-01-01T00:00:00.000Z")
            }
        ];

        const list = await listOpenable(ALICE);

        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: "conn-1", origin: "saved", readOnly: false });
    });

    it("offers Polaris' own database only to an account that runs the instance", async () => {
        expect(await listOpenable(ALICE)).toHaveLength(0);

        runsTheInstance = true;
        const [own] = await listOpenable(ALICE);

        expect(own).toMatchObject({
            id: "polaris",
            origin: "polaris",
            engine: "postgres",
            database: "polaris",
            readOnly: true
        });
    });

    it("does not offer Polaris' own database when it is a file", async () => {
        runsTheInstance = true;
        provider = "sqlite";
        databaseUrl = "file:./polaris-dev.db";

        expect(await listOpenable(ALICE)).toHaveLength(0);
    });
});

describe("resolving an offered id", () => {
    it("reads a managed database's address and credentials, read-only", async () => {
        managed = [managedRow()];

        const address = await addressOf(ALICE, `managed:${DB}`);

        expect(address).toMatchObject({
            engine: "postgres",
            host: "polaris-app-db",
            port: 5432,
            database: "app",
            username: "app",
            password: "app-secret",
            readOnly: true
        });
    });

    it("refuses a managed id this account does not reach", async () => {
        managed = [];

        await expect(addressOf(ALICE, `managed:${DB}`)).rejects.toThrow(/not there any more/);
    });

    it("refuses Polaris' own database without system.manage", async () => {
        await expect(addressOf(ALICE, "polaris")).rejects.toThrow(/not one you can open/);

        runsTheInstance = true;
        await expect(addressOf(ALICE, "polaris")).resolves.toMatchObject({
            host: "postgres",
            port: 5432,
            database: "polaris",
            username: "polaris",
            password: "secret",
            readOnly: true
        });
    });
});
