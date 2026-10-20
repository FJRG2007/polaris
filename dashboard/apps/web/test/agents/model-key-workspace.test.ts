/**
 * The Workspace ID on an Anthropic key: checked with the key, stored beside it,
 * and asked for when Anthropic says the key needs one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    checks: [] as Array<{ provider: string; workspaceId?: string | null }>,
    created: [] as Array<{ provider: string; config?: Record<string, unknown> }>,
    updated: [] as Array<{ workspaceId?: string | null }>,
    verdict: { state: "valid" } as Record<string, unknown>
}));

vi.mock("@/lib/agents/model-keys", () => ({
    createModelKey: async (
        _owner: unknown,
        input: { provider: string; config?: Record<string, unknown> }
    ) => void state.created.push(input),
    updateModelKey: async (
        _owner: unknown,
        _id: string,
        input: { workspaceId?: string | null }
    ) => {
        state.updated.push(input);
        return true;
    },
    providerOfModelKey: async () => "anthropic",
    isStorableProvider: () => true,
    ownerHasModelKeyName: async () => false,
    ownerHasModelSecret: async () => false,
    deleteModelKey: vi.fn(),
    reorderModelKeys: vi.fn(),
    setModelKeyEnabled: vi.fn()
}));
vi.mock("@/lib/agents/provider-key-check", () => ({
    checkProviderKey: async (
        provider: string,
        _secret: string,
        options: { workspaceId?: string | null } = {}
    ) => {
        state.checks.push({ provider, workspaceId: options.workspaceId });
        return state.verdict;
    }
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));

const { addKey, editKey } = await import("@/lib/agents/model-key-actions");

const scope = {
    owner: "user-1",
    actorId: "user-1",
    path: "/account/ai-keys",
    audit: "account" as const
};
const WORKSPACE = "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ";
const ID = "0190a3c2-7a3e-7000-8000-000000000001";

beforeEach(() => {
    state.checks = [];
    state.created = [];
    state.updated = [];
    state.verdict = { state: "valid" };
});

describe("adding an Anthropic key with a workspace", () => {
    it("checks the key in that workspace and stores the workspace with it", async () => {
        const result = await addKey(scope, {
            provider: "anthropic",
            name: "work",
            secret: "sk-ant-usr-abcdefgh",
            workspaceId: WORKSPACE
        });
        expect(result).toEqual({});
        expect(state.checks).toEqual([{ provider: "anthropic", workspaceId: WORKSPACE }]);
        expect(state.created[0]?.config).toEqual({ workspaceId: WORKSPACE });
    });

    it("tells the form to ask for the workspace when Anthropic wants one", async () => {
        state.verdict = { state: "rejected", code: "workspace", reason: "needs a workspace" };
        const result = await addKey(scope, {
            provider: "anthropic",
            name: "work",
            secret: "sk-ant-usr-abcdefgh"
        });
        expect(result).toEqual({ error: "needs a workspace", needsWorkspace: true });
        expect(state.created).toEqual([]);
    });

    it("refuses a workspace ID that is not one", async () => {
        const result = await addKey(scope, {
            provider: "anthropic",
            name: "work",
            secret: "sk-ant-usr-abcdefgh",
            workspaceId: "default"
        });
        expect(result.error).toBeTruthy();
        expect(state.checks).toEqual([]);
    });

    it("drops a workspace on a provider that has none", async () => {
        await addKey(scope, {
            provider: "openai",
            name: "work",
            secret: "sk-proj-abcdefgh",
            workspaceId: WORKSPACE
        });
        expect(state.checks[0]?.workspaceId).toBeUndefined();
        expect(state.created[0]?.config).toBeUndefined();
    });
});

describe("editing an Anthropic key's workspace", () => {
    it("stores a new workspace without asking for the key again", async () => {
        expect(await editKey(scope, { id: ID, name: "work", workspaceId: WORKSPACE })).toEqual({});
        expect(state.checks).toEqual([]);
        expect(state.updated[0]?.workspaceId).toBe(WORKSPACE);
    });

    it("clears it with null", async () => {
        await editKey(scope, { id: ID, name: "work", workspaceId: null });
        expect(state.updated[0]?.workspaceId).toBeNull();
    });

    it("checks a retyped key in the workspace it will act in", async () => {
        await editKey(scope, {
            id: ID,
            name: "work",
            secret: "sk-ant-usr-abcdefgh",
            workspaceId: WORKSPACE
        });
        expect(state.checks).toEqual([{ provider: "anthropic", workspaceId: WORKSPACE }]);
    });
});
