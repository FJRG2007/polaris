/**
 * Keys stored before hints existed get one the first time they are listed, and
 * the listing never carries the secret itself.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string; keyHint: string | null; plain: string };
const state = { rows: [] as Row[], writes: [] as Array<{ id: string; hint: string }> };

const view = (row: Row) => {
    const { plain: _plain, encryptedSecret: _blob, ...rest } = row;
    return rest;
};

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "test" }) }));
vi.mock("@polaris/storage", () => ({
    encryptSecret: vi.fn(),
    secretFingerprint: vi.fn(),
    CredentialDecryptError: class extends Error {},
    decryptSecret: ({ keyId }: { keyId: string }) =>
        state.rows.find((row) => row.secretKeyId === keyId)!.plain
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        userModelKey: {
            findMany: async ({ where }: { where: { id?: { in: string[] } } }) =>
                where.id
                    ? state.rows
                          .filter((row) => where.id!.in.includes(row.id) && row.keyHint === null)
                          .map((row) => ({ ...row, encryptedSecret: new Uint8Array([1]) }))
                    : state.rows.map(view),
            updateMany: async ({ where, data }: { where: { id: string }; data: { keyHint: string } }) => {
                state.writes.push({ id: where.id, hint: data.keyHint });
                return { count: 1 };
            }
        }
    }
}));

const { listModelKeys } = await import("@/lib/agents/model-keys");

const row = (id: string, plain: string, keyHint: string | null): Row => ({
    id,
    plain,
    keyHint,
    provider: "groq",
    name: id,
    priority: 0,
    config: "{}",
    expiresAt: null,
    lastUsedAt: null,
    enabled: true,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    limits: "{}",
    coolingUntil: null,
    coolingReason: null,
    secretNonce: new Uint8Array([2]),
    secretKeyId: `k-${id}`
});

describe("listModelKeys key hints", () => {
    beforeEach(() => {
        state.rows = [];
        state.writes = [];
    });

    it("fills a missing hint once and leaves stored ones alone", async () => {
        state.rows = [
            row("old", "gsk_abcdefghijklmnopqrstuvwxyz16189", null),
            row("new", "irrelevant", "sk-...99999")
        ];
        const listed = await listModelKeys("user-1");
        expect(listed.map((key) => key.keyHint)).toEqual(["gsk_...16189", "sk-...99999"]);
        expect(state.writes).toEqual([{ id: "old", hint: "gsk_...16189" }]);
        expect(JSON.stringify(listed)).not.toContain("abcdefghijklmnop");
    });

    it("writes nothing when every row already has a hint", async () => {
        state.rows = [row("a", "x", ""), row("b", "y", "...abcd")];
        await listModelKeys("user-1");
        expect(state.writes).toEqual([]);
    });
});
