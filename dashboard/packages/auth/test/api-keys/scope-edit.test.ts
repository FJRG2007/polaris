/**
 * Changing an existing key's scopes takes effect on its very next call.
 *
 * A key is resolved from its row on every request, never from a cache, so a
 * scope taken off a key is refused the next time the key is presented and one
 * added is honoured at once - as long as the owner still holds it. Only the
 * owner can change it.
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

const { createApiKey, updateApiKey, verifyApiKey } = await import("../../src/api-keys.js");

async function makeKey(scopes: string[]) {
    return createApiKey(OWNER, createApiKeySchema.parse({ name: "Deploy bot", scopes }));
}

function edit(id: string, scopes: string[]) {
    return updateApiKeySchema.parse({ id, name: "Deploy bot", scopes });
}

beforeEach(() => {
    keys = [];
    held = new Set(["tasks.read", "tasks.manage", "deploy.read"]);
});

describe("changing a key's scopes", () => {
    it("refuses a removed scope on the next call", async () => {
        const key = await makeKey(["tasks.read", "deploy.read"]);
        expect((await verifyApiKey(key.secret))?.scopes.sort()).toEqual([
            "deploy.read",
            "tasks.read"
        ]);
        await updateApiKey(OWNER, edit(key.id, ["tasks.read"]));
        expect((await verifyApiKey(key.secret))?.scopes).toEqual(["tasks.read"]);
    });

    it("honours an added scope at once, but never past what the owner holds", async () => {
        const key = await makeKey(["tasks.read"]);
        await updateApiKey(OWNER, edit(key.id, ["tasks.read", "deploy.read"]));
        expect((await verifyApiKey(key.secret))?.scopes.sort()).toEqual([
            "deploy.read",
            "tasks.read"
        ]);
        held = new Set(["tasks.read"]);
        expect((await verifyApiKey(key.secret))?.scopes).toEqual(["tasks.read"]);
    });

    it("leaves a key alone when somebody else tries to change it", async () => {
        const key = await makeKey(["tasks.read", "deploy.read"]);
        await updateApiKey(OTHER, edit(key.id, ["tasks.read"]));
        expect((await verifyApiKey(key.secret))?.scopes.sort()).toEqual([
            "deploy.read",
            "tasks.read"
        ]);
    });
});
