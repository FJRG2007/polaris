/**
 * The free tier ends every plan: a turn whose models all refused is answered
 * by a Zen model, unless the plan already ends there or an administrator
 * switched the free tier off.
 */

import { ZEN_MODELS_ANSWER } from "../fixtures/zen-models";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { policy: null as string | null };

vi.mock("@/lib/api-session", () => ({ apiUser: async () => null }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/auth", () => ({ resolveGlobalStatements: async () => [] }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => state.policy,
    setSetting: async () => undefined
}));
vi.mock("@/lib/agents/model-keys", () => ({ instanceKeysAreShared: async () => false }));

const { zenLastStep, zenStandInModel } = await import("@/lib/polar/zen-stand-in");
const zen = await import("@/lib/polar/zen-free");
const { ZEN_FREE_SLUG } = await import("@/lib/polar/shared");

const ACCESS = { use: true, spend: false, web: true, connectors: false };

beforeEach(() => {
    state.policy = null;
    zen.resetZenCache(async () => ZEN_MODELS_ANSWER);
});

describe("Zen as the last stand-in", () => {
    it("ends a plan on a free model with the public key", async () => {
        const step = await zenLastStep(ACCESS, "openai");
        expect(step?.option).toMatchObject({ provider: ZEN_FREE_SLUG, model: "big-pickle", costInput: 0 });
        expect(step?.credential.secret).toBe("public");
    });

    it("picks a model that reads files when the turn carries one", async () => {
        const step = await zenLastStep(ACCESS, "openai", true);
        expect(step?.option.model).toBe("deepseek-v4.1-flash-free");
    });

    it("adds nothing to a plan that already ends on it", async () => {
        expect(await zenLastStep(ACCESS, ZEN_FREE_SLUG)).toBeNull();
    });

    it("adds nothing once an administrator switched it off", async () => {
        state.policy = JSON.stringify({
            use: { who: "everyone", userIds: [], groupIds: [], guests: false },
            spend: { who: "admins", userIds: [], groupIds: [], guests: false },
            freeModels: false
        });
        expect(await zenLastStep(ACCESS, "openai")).toBeNull();
    });

    it("adds nothing when Zen lists no free model", async () => {
        zen.resetZenCache(async () => ({ data: [] }));
        expect(await zenLastStep(ACCESS, "openai")).toBeNull();
        expect(zenStandInModel([], false)).toBeNull();
    });
});
