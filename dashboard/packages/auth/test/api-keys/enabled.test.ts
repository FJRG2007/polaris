/**
 * Switching a key off, and back on.
 *
 * Off is refused by the API exactly like a revoked key - the same null from
 * `verifyApiKey` - but the key is kept, and switching it on again is all it
 * takes. A revoked key cannot be brought back this way.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKeySchema, updateApiKeySchema } from "@polaris/core";

const OWNER = "0190a1b2-c3d4-7e5f-8a9b-00000000a0a0";
const OTHER = "0190a1b2-c3d4-7e5f-8a9b-00000000b0b0";

type Row = Record<string, unknown>;
let keys: Row[] = [];
let held = new Set<string>();

vi.mock("@polaris/db", () => ({
    prisma: {
        apiKey: {
            create: async ({ data }: { data: Row }) => {
                const { groups: _groups, ...fields } = data;
                const row: Row = {
                    id: `0190a1b2-c3d4-7e5f-8a9b-00000000c00${keys.length + 1}`,
                    revokedAt: null,
                    enabled: true,
                    expiresAt: null,
                    projectId: null,
                    kind: "key",
                    lastUsedIp: null,
                    pinToAddress: null,
                    clientOs: null,
                    ...fields
                };
                keys.push(row);
                return { id: row.id };
            },
            findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
                keys.find((row) => row.id === where.id && row.userId === where.userId) ?? null,
            findUnique: async ({ where }: { where: { prefix: string } }) => {
                const row = keys.find((entry) => entry.prefix === where.prefix);
                return row
                    ? { ...row, groups: [], user: { bannedAt: null, isAdmin: false } }
                    : null;
            },
            updateMany: async ({
                where,
                data
            }: {
                where: { id: string; userId: string; revokedAt: null };
                data: Row;
            }) => {
                const matched = keys.filter(
                    (row) =>
                        row.id === where.id && row.userId === where.userId && row.revokedAt === null
                );
                for (const row of matched) Object.assign(row, data);
                return { count: matched.length };
            },
            update: async ({ where, data }: { where: { id: string }; data: Row }) => {
                const row = keys.find((entry) => entry.id === where.id)!;
                Object.assign(row, data);
                return row;
            }
        },
        accessGroup: { findMany: async () => [] },
        apiKeyAccessGroup: {
            deleteMany: async () => ({ count: 0 }),
            createMany: async () => ({ count: 0 })
        },
        $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations)
    }
}));
vi.mock("../../src/roles.js", () => ({ getUserPermissions: async () => new Set(held) }));

const { createApiKey, revokeApiKey, setApiKeyEnabled, verifyApiKey } = await import(
    "../../src/api-keys.js"
);

async function makeKey() {
    return createApiKey(
        OWNER,
        createApiKeySchema.parse({ name: "Deploy bot", scopes: ["tasks.read"] })
    );
}

beforeEach(() => {
    keys = [];
    held = new Set(["tasks.read"]);
});

describe("a key switched off", () => {
    it("is refused like a revoked key", async () => {
        const key = await makeKey();
        expect(await verifyApiKey(key.secret)).not.toBeNull();
        expect(await setApiKeyEnabled(OWNER, key.id, false)).toBe(true);
        expect(await verifyApiKey(key.secret)).toBeNull();
    });

    it("works again once switched back on", async () => {
        const key = await makeKey();
        await setApiKeyEnabled(OWNER, key.id, false);
        await setApiKeyEnabled(OWNER, key.id, true);
        expect((await verifyApiKey(key.secret))?.scopes).toEqual(["tasks.read"]);
    });

    it("cannot be switched by anybody else", async () => {
        const key = await makeKey();
        expect(await setApiKeyEnabled(OTHER, key.id, false)).toBe(false);
        expect(await verifyApiKey(key.secret)).not.toBeNull();
    });

    it("does not bring a revoked key back", async () => {
        const key = await makeKey();
        await revokeApiKey(OWNER, key.id);
        expect(await setApiKeyEnabled(OWNER, key.id, true)).toBe(false);
        expect(await verifyApiKey(key.secret)).toBeNull();
    });
});
