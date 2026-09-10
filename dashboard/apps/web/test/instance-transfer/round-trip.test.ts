/**
 * An instance exported under one master key and imported onto a fresh install
 * with another: the rows arrive, their secrets open with the new key, the audit
 * trail is sealed again, and the wrong passphrase or an instance in use is refused
 * before anything is written.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE_KEY = Buffer.alloc(32, 1).toString("base64");
const TARGET_KEY = Buffer.alloc(32, 2).toString("base64");

vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", SOURCE_KEY);

const { tables, raw } = vi.hoisted(() => ({
    tables: new Map<string, Record<string, unknown>[]>(),
    raw: [] as string[]
}));

vi.mock("@polaris/db", async () => {
    const actual = await vi.importActual<typeof import("@polaris/db")>("@polaris/db");
    const rowsOf = (model: string) => {
        if (!tables.has(model)) tables.set(model, []);
        return tables.get(model)!;
    };
    const delegateFor = (key: string) => {
        const model = key.charAt(0).toUpperCase() + key.slice(1);
        return {
            findMany: async ({ skip = 0, take = 1000 }: { skip?: number; take?: number } = {}) =>
                rowsOf(model).slice(skip, skip + take),
            createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
                rowsOf(model).push(...data.map((row) => ({ ...row })));
                return { count: data.length };
            },
            update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                const row = rowsOf(model).find((one) => Object.entries(where).every(([k, v]) => one[k] === v));
                if (row) Object.assign(row, data);
                return row;
            },
            deleteMany: async () => {
                tables.set(model, []);
                return { count: 0 };
            },
            count: async () => rowsOf(model).length
        };
    };
    const client: Record<string, unknown> = new Proxy(
        {},
        {
            get(_target, key: string) {
                if (key === "$transaction") return async (run: (tx: unknown) => Promise<unknown>) => run(client);
                if (key === "$executeRawUnsafe")
                    return async (sql: string) => {
                        raw.push(sql);
                        if (sql.startsWith("TRUNCATE")) tables.clear();
                        return 0;
                    };
                return delegateFor(key);
            }
        }
    );
    return { ...actual, prisma: client };
});

const { resetEnvCache } = await import("@polaris/config");
const { decryptSecret, encryptSecret } = await import("@polaris/storage");
const transfer = await import("@/lib/instance-transfer/transfer");

const USER = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";

function useKey(key: string) {
    vi.stubEnv("POLARIS_MASTER_KEY", key);
    resetEnvCache();
}

async function exported(passphrase = "correct horse battery staple") {
    const dir = await mkdtemp(join(tmpdir(), "polaris-transfer-test-"));
    const path = join(dir, "instance.polaris");
    const summary = await transfer.exportInstance(passphrase, path);
    return { path, summary };
}

beforeEach(() => {
    tables.clear();
    raw.length = 0;
    useKey(SOURCE_KEY);
    const sealed = encryptSecret("db-password", SOURCE_KEY);
    tables.set("User", [{ id: USER, email: "a@example.com", name: "A", createdAt: new Date("2026-01-01T00:00:00Z") }]);
    tables.set("EnvVar", [
        { id: "e1", key: "DATABASE_PASSWORD", encryptedValue: sealed.ciphertext, valueNonce: sealed.nonce, valueKeyId: sealed.keyId }
    ]);
    tables.set("AuditLog", [{ id: "a1", action: "x", seq: 7n, hash: "old", at: new Date() }]);
    tables.set("Session", [{ id: "s1", userId: USER, token: "t" }]);
});

describe("moving an instance", () => {
    it("reads back what was exported, and leaves sessions behind", async () => {
        const { path, summary } = await exported();
        expect(summary.carriedSecrets).toBe(1);
        const preview = await transfer.previewTransfer(path, "correct horse battery staple");
        expect(preview.tables).toEqual(
            expect.arrayContaining([
                { name: "User", rows: 1 },
                { name: "EnvVar", rows: 1 }
            ])
        );
        expect(preview.tables.find((table) => table.name === "Session")).toBeUndefined();
    });

    it("refuses the wrong passphrase", async () => {
        const { path } = await exported();
        await expect(transfer.previewTransfer(path, "not the passphrase!!")).rejects.toThrow(/passphrase is wrong/);
    });

    it("lands on a fresh install with its secrets sealed under the new key", async () => {
        const { path } = await exported();
        // The fresh install: one account, its own key.
        tables.clear();
        tables.set("User", [{ id: "fresh-admin" }]);
        useKey(TARGET_KEY);
        await transfer.applyTransfer(path, "correct horse battery staple");
        expect(raw[0]).toMatch(/^TRUNCATE TABLE/);
        expect(tables.get("User")?.map((row) => row.id)).toEqual([USER]);
        const envVar = tables.get("EnvVar")![0]!;
        const opened = decryptSecret(
            {
                ciphertext: envVar.encryptedValue as Buffer,
                nonce: envVar.valueNonce as Buffer,
                keyId: envVar.valueKeyId as string
            },
            TARGET_KEY
        );
        expect(opened).toBe("db-password");
        const audit = tables.get("AuditLog")![0]!;
        expect(audit.seq).toBeNull();
        expect(audit.hash).toBeNull();
    });

    it("refuses an instance that is already in use, before writing anything", async () => {
        const { path } = await exported();
        tables.set("User", [{ id: "one" }, { id: "two" }]);
        await expect(transfer.applyTransfer(path, "correct horse battery staple")).rejects.toThrow(/fresh install/);
        expect(raw).toHaveLength(0);
    });
});
