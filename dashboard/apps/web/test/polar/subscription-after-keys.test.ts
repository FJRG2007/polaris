/**
 * A Claude subscription signed in on the person's computer answers an
 * Anthropic model picked by hand: it is planned right after their Anthropic
 * keys, and a subscription token saved as an Anthropic key is never sent to
 * the API as one (the API refuses it as "invalid x-api-key").
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    keys: [] as Array<{ provider: string; source: "own"; secret: string; keyId: string }>,
    online: true
}));

vi.mock("@/lib/api-session", () => ({ apiUser: async () => null }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/auth", () => ({ resolveGlobalStatements: async () => [] }));
vi.mock("@/lib/polar/router/store", () => ({ polarRouting: async () => ({ fallbacks: [] }) }));
vi.mock("@/lib/polar/usage", () => ({
    routeRecord: () => ({ keyId: null, fellBack: null }),
    polarLimitReached: async () => null
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => null,
    setSetting: async () => undefined
}));
vi.mock("@/lib/agents/model-keys", () => ({
    keySourcesFor: async () => new Map([["anthropic", "own"]]),
    instanceKeysAreShared: async () => false,
    chatCredentialFor: async () => state.keys[0] ?? null,
    chatCredentialsFor: async () => state.keys
}));
vi.mock("@/lib/agents/model-catalog", () => ({
    listCatalogModels: async () => [
        {
            slug: "anthropic/claude-sonnet-4-5",
            provider: "anthropic",
            modelId: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            contextTokens: 200_000,
            outputTokens: 64_000,
            effortRungs: [],
            reasoning: true,
            attachment: true,
            costInput: 3,
            costOutput: 15,
            inputModalities: ["text", "image"],
            releaseDate: null
        }
    ],
    latestCatalogModels: async () => []
}));
vi.mock("@/lib/polar/provider-windows", () => ({
    providerWindows: async () => new Map(),
    WINDOW_PROVIDERS: []
}));
vi.mock("@/lib/polar/claude-subscription/turns", async (actual) => ({
    ...(await actual<object>()),
    subscriptionRunnerFor: async () => (state.online ? { id: "computer-1" } : null)
}));

const { resolvePolarModel, subscriptionModelFor, subscriptionProvider } = await import("@/lib/polar/models");
const { polarCredentialFor, polarCredentialsFor } = await import("@/lib/polar/access");
const { PLAIN_TURN } = await import("@/lib/polar/automatic");

const ACCESS = { use: true, spend: false, web: true, connectors: false, zenStandInEveryone: false };
const API_KEY = { provider: "anthropic", source: "own" as const, secret: "sk-ant-api03-key", keyId: "k1" };
const SETUP_TOKEN = { provider: "anthropic", source: "own" as const, secret: "sk-ant-oat01-token", keyId: "k2" };
const SONNET = { kind: "language", provider: "anthropic", model: "claude-sonnet-4-5" } as never;

beforeEach(() => {
    state.keys = [API_KEY];
    state.online = true;
});

describe("an Anthropic model with a Claude subscription online", () => {
    it("is planned on the Anthropic key, then on the subscription's same model", async () => {
        const resolved = await resolvePolarModel("sub-1", SONNET, PLAIN_TURN, ACCESS as never);
        if (typeof resolved === "string") throw new Error(resolved);
        expect(resolved.option.provider).toBe("anthropic");
        expect(resolved.standIns?.map((entry) => [entry.option.provider, entry.option.model])).toEqual([
            ["claude-subscription", "sonnet"]
        ]);
    });

    it("is answered by the subscription alone when the only key is its token", async () => {
        state.keys = [SETUP_TOKEN];
        const resolved = await resolvePolarModel("sub-2", SONNET, PLAIN_TURN, ACCESS as never);
        if (typeof resolved === "string") throw new Error(resolved);
        expect([resolved.option.provider, resolved.option.model]).toEqual(["claude-subscription", "sonnet"]);
        expect(resolved.standIns ?? []).toEqual([]);
    });

    it("is not offered the subscription while no computer runs it", async () => {
        state.online = false;
        const resolved = await resolvePolarModel("sub-3", SONNET, PLAIN_TURN, ACCESS as never);
        if (typeof resolved === "string") throw new Error(resolved);
        expect(resolved.standIns ?? []).toEqual([]);
        state.keys = [SETUP_TOKEN];
        expect(await resolvePolarModel("sub-4", SONNET, PLAIN_TURN, ACCESS as never)).toBe("no_key");
    });
});

describe("a subscription token saved as an Anthropic key", () => {
    it("is never one of the keys a call spends", async () => {
        state.keys = [SETUP_TOKEN, API_KEY];
        expect(await polarCredentialsFor("sub-5", "anthropic", null, ACCESS as never)).toEqual([API_KEY]);
        expect(await polarCredentialFor("sub-5", "anthropic", null, ACCESS as never)).toEqual(API_KEY);
        state.keys = [SETUP_TOKEN];
        expect(await polarCredentialFor("sub-6", "anthropic", null, ACCESS as never)).toBeNull();
    });
});

describe("subscriptionModelFor", () => {
    it("matches the family, and nothing without the subscription", () => {
        const catalogue = [subscriptionProvider()];
        expect(subscriptionModelFor("claude-opus-4-1-20250805", catalogue)?.model).toBe("opus");
        expect(subscriptionModelFor("claude-3-5-haiku-latest", catalogue)?.model).toBe("haiku");
        expect(subscriptionModelFor("claude-2.1", catalogue)).toBeNull();
        expect(subscriptionModelFor("claude-sonnet-4-5", [])).toBeNull();
    });
});
