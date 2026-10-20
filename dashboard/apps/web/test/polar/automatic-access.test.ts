/**
 * Automatic is held to the same access policy as a picked model: the models it
 * chooses from and the key it spends both come through the Polar access
 * module, so a person the policy keeps off the deployment's keys never gets one
 * through Automatic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    sources: [] as unknown[],
    credentials: [] as unknown[][],
    credential: { provider: "openai", secret: "own-key", source: "own" } as unknown
};

const CLOSED = { use: true, spend: false };

vi.mock("@/lib/polar/access", () => ({
    polarAccessFor: async () => CLOSED,
    polarKeySources: async (_userId: string, access: unknown) => {
        state.sources.push(access);
        return new Map([["openai", "own"]]);
    },
    polarCredentialFor: async (...args: unknown[]) => {
        state.credentials.push(args);
        return state.credential;
    }
}));
vi.mock("@/lib/agents/model-catalog", () => ({
    listCatalogModels: async () => [
        {
            slug: "openai/mini",
            provider: "openai",
            modelId: "mini",
            name: "Mini",
            contextTokens: 100_000,
            outputTokens: 10_000,
            effortRungs: [],
            reasoning: false,
            attachment: false,
            costInput: 1,
            costOutput: 2,
            inputModalities: ["text"],
            releaseDate: null
        }
    ]
}));

const { resolvePolarModel } = await import("@/lib/polar/models");
const { automaticChoice } = await import("@/lib/polar/shared");
const { PLAIN_TURN } = await import("@/lib/polar/automatic");

beforeEach(() => {
    state.sources = [];
    state.credentials = [];
    state.credential = { provider: "openai", secret: "own-key", source: "own" };
});

describe("Automatic under the access policy", () => {
    it("lists models and reads the key under the person's access", async () => {
        const resolved = await resolvePolarModel("u1", automaticChoice(), PLAIN_TURN);
        expect(typeof resolved).not.toBe("string");
        expect(state.sources).toEqual([CLOSED]);
        expect(state.credentials).toEqual([["u1", "openai", null, CLOSED]]);
    });

    it("answers no_key when the policy hands it no key", async () => {
        state.credential = null;
        expect(await resolvePolarModel("u1", automaticChoice(), PLAIN_TURN)).toBe("no_key");
    });
});
