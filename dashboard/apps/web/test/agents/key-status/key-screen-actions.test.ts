/**
 * The limit and revive writes on both key screens: each hands the shared write
 * its own scope - the signed-in person's keys on /account/ai-keys, the
 * deployment's on /integrations/models - so neither screen can reach the
 * other's rows.
 */

import { describe, expect, it, vi } from "vitest";

const calls: Array<{ write: string; owner: string | null; path: string; input: unknown }> = [];

vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "user-1" }),
    requireAdmin: async () => ({ id: "admin-1" })
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/agents/signin-runtime", () => ({}));
vi.mock("@polaris/core", () => ({
    agentSigninAnswerSchema: {},
    agentSigninEnvSchema: {},
    agentSigninIdSchema: {}
}));
vi.mock("@/lib/agents/model-keys", () => ({ INSTANCE: null }));
vi.mock("@/lib/agents/model-key-actions", () => {
    const capture =
        (write: string) =>
        async (scope: { owner: string | null; path: string }, input: unknown) => {
            calls.push({ write, owner: scope.owner, path: scope.path, input });
            return {};
        };
    return {
        addKey: capture("add"),
        editKey: capture("edit"),
        removeKey: capture("remove"),
        reorderKeys: capture("reorder"),
        toggleKey: capture("toggle"),
        limitKey: capture("limit"),
        reviveKey: capture("revive")
    };
});

const account = await import("@/app/(app)/account/ai-keys/actions");
const instance = await import("@/app/(app)/admin/integrations/models/actions");

const ID = "0190a3c2-7a3e-7000-8000-000000000001";

describe("key screen actions", () => {
    it("limits and revives the signed-in person's own keys", async () => {
        calls.length = 0;
        await account.limitModelKeyAction({ id: ID, limits: {} });
        await account.reviveModelKeyAction({ id: ID });
        expect(calls).toEqual([
            { write: "limit", owner: "user-1", path: "/account/ai-keys", input: { id: ID, limits: {} } },
            { write: "revive", owner: "user-1", path: "/account/ai-keys", input: { id: ID } }
        ]);
    });

    it("limits and revives the deployment's keys", async () => {
        calls.length = 0;
        await instance.limitInstanceModelKeyAction({ id: ID, limits: {} });
        await instance.reviveInstanceModelKeyAction({ id: ID });
        expect(calls.map((call) => [call.write, call.owner, call.path])).toEqual([
            ["limit", null, "/admin/integrations/models"],
            ["revive", null, "/admin/integrations/models"]
        ]);
    });
});
