/**
 * The free tier ends every plan: a turn whose models all refused is answered
 * by a Zen model, unless the plan already ends there or an administrator
 * switched the free tier off. A person with a key of their own gets it only
 * once an administrator opts everybody in.
 */

import { ZEN_MODELS_ANSWER } from "../fixtures/zen-models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const access = await import("@/lib/polar/access");

const ACCESS = { use: true, spend: false, web: true, connectors: false, zenStandInEveryone: false };
const NO_KEY = { ownKey: false };
const POLICY = {
    use: { who: "everyone", userIds: [], groupIds: [], guests: false },
    spend: { who: "admins", userIds: [], groupIds: [], guests: false }
};

beforeEach(() => {
    state.policy = null;
    zen.resetZenCache(async () => ZEN_MODELS_ANSWER);
});

describe("Zen as the last stand-in", () => {
    // A day both fixture models are current on (one a year old, one new), so
    // the list Polar keeps (`currentModels`) does not change with the day the
    // suite runs.
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    });
    afterEach(() => vi.useRealTimers());

    it("ends a plan on a free model with the public key", async () => {
        const step = await zenLastStep(ACCESS, "openai", NO_KEY);
        expect(step?.option).toMatchObject({ provider: ZEN_FREE_SLUG, model: "big-pickle", costInput: 0 });
        expect(step?.credential.secret).toBe("public");
    });

    it("picks a model that reads files when the turn carries one", async () => {
        const step = await zenLastStep(ACCESS, "openai", { needsAttachment: true, ownKey: false });
        expect(step?.option.model).toBe("deepseek-v4.1-flash-free");
    });

    it("adds nothing to a plan that already ends on it", async () => {
        expect(await zenLastStep(ACCESS, ZEN_FREE_SLUG, NO_KEY)).toBeNull();
    });

    it("adds nothing once an administrator switched it off", async () => {
        state.policy = JSON.stringify({ ...POLICY, freeModels: false });
        expect(await zenLastStep(ACCESS, "openai", NO_KEY)).toBeNull();
    });

    it("adds nothing when Zen lists no free model", async () => {
        zen.resetZenCache(async () => ({ data: [] }));
        expect(await zenLastStep(ACCESS, "openai", NO_KEY)).toBeNull();
        expect(zenStandInModel([], false)).toBeNull();
    });

    it("leaves a person with a key of their own to their own models", async () => {
        expect(await zenLastStep(ACCESS, "openai", { ownKey: true })).toBeNull();
    });

    it("reaches a person with a key once an administrator opts everyone in", async () => {
        const access = { ...ACCESS, zenStandInEveryone: true };
        const step = await zenLastStep(access, "openai", { ownKey: true });
        expect(step?.option.provider).toBe(ZEN_FREE_SLUG);
    });
});

describe("the opt-in switch", () => {
    const { decidePolarAccess, polarPolicySchema, DEFAULT_POLAR_POLICY } = access;
    const FACTS = { userId: "00000000-0000-4000-8000-000000000001", isAdmin: false, guest: false, groupIds: [] };

    it("is off on a policy saved before it existed", () => {
        const stored = polarPolicySchema.parse({ ...POLICY, freeModels: true });
        expect(stored.zenStandInEveryone).toBe(false);
        expect(decidePolarAccess(stored, FACTS).zenStandInEveryone).toBe(false);
        expect(DEFAULT_POLAR_POLICY.zenStandInEveryone).toBe(false);
    });

    it("opts everyone in only while the free tier is on and the person may use Polar", () => {
        const on = polarPolicySchema.parse({ ...POLICY, zenStandInEveryone: true });
        expect(decidePolarAccess(on, FACTS).zenStandInEveryone).toBe(true);
        expect(decidePolarAccess({ ...on, freeModels: false }, FACTS).zenStandInEveryone).toBe(false);
        const closed = { ...on, use: { ...on.use, who: "admins" as const } };
        expect(decidePolarAccess(closed, FACTS).zenStandInEveryone).toBe(false);
    });
});
