/**
 * Switching a provider key on or off from its list.
 *
 * The switch keeps the row and leaves an audit entry like adding or deleting
 * one does, so an administrator can tell later who stopped a key being spent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    rows: new Map<string, { userId: string | null; enabled: boolean }>(),
    audits: [] as Array<{ action: string; targetId?: string }>
};

vi.mock("@/lib/agents/model-keys", () => ({
    setModelKeyEnabled: async (owner: string | null, id: string, enabled: boolean) => {
        const row = state.rows.get(id);
        if (!row || row.userId !== owner) return false;
        row.enabled = enabled;
        return true;
    },
    createModelKey: vi.fn(),
    deleteModelKey: vi.fn(),
    heldModelKey: vi.fn(),
    isStorableProvider: vi.fn(),
    ownerHasModelKeyName: vi.fn(),
    ownerHasModelSecret: vi.fn(),
    providerOfModelKey: vi.fn(),
    reorderModelKeys: vi.fn(),
    updateModelKey: vi.fn()
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (entry: { action: string; targetId?: string }) =>
        void state.audits.push(entry)
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/agents/provider-key-check", () => ({ checkProviderKey: vi.fn() }));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));

const { toggleKey } = await import("@/lib/agents/model-key-actions");

const ID = "0190a3c2-7a3e-7000-8000-000000000001";
const scope = {
    owner: null,
    actorId: "admin-1",
    path: "/admin/integrations/models",
    audit: "instance" as const
};

beforeEach(() => {
    state.rows = new Map([[ID, { userId: null, enabled: true }]]);
    state.audits = [];
});

describe("toggleKey", () => {
    it("switches a deployment key off and records who did it", async () => {
        expect(await toggleKey(scope, { id: ID, enabled: false })).toEqual({});
        expect(state.rows.get(ID)?.enabled).toBe(false);
        expect(state.audits).toEqual([
            expect.objectContaining({ action: "instance.ai-key.disabled", targetId: ID })
        ]);
    });

    it("switches it back on", async () => {
        state.rows.get(ID)!.enabled = false;
        await toggleKey(scope, { id: ID, enabled: true });
        expect(state.rows.get(ID)?.enabled).toBe(true);
        expect(state.audits[0]?.action).toBe("instance.ai-key.enabled");
    });

    it("refuses a key this owner does not hold, and records nothing", async () => {
        state.rows.set(ID, { userId: "someone", enabled: true });
        expect(await toggleKey(scope, { id: ID, enabled: false })).toEqual({
            error: "refusals.aiKeys.keyGone"
        });
        expect(state.audits).toEqual([]);
    });

    it("refuses input that is not an id and a boolean", async () => {
        expect(await toggleKey(scope, { id: ID, enabled: "no" })).toEqual({
            error: "refusals.aiKeys.pickKey"
        });
    });

    it("switches a person's own key off on their own screen, and no one else's", async () => {
        const own = {
            owner: "user-1",
            actorId: "user-1",
            path: "/account/ai-keys",
            audit: "account" as const
        };
        state.rows.set(ID, { userId: "user-1", enabled: true });
        expect(await toggleKey(own, { id: ID, enabled: false })).toEqual({});
        expect(state.rows.get(ID)?.enabled).toBe(false);
        expect(state.audits[0]?.action).toBe("account.ai-key.disabled");
        state.rows.set(ID, { userId: "user-2", enabled: true });
        expect((await toggleKey(own, { id: ID, enabled: false })).error).toBeTruthy();
        expect(state.rows.get(ID)?.enabled).toBe(true);
    });
});
