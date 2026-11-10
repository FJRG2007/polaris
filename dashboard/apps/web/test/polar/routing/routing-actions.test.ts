/**
 * The Routing section's writes: a person's own routing is checked whole - no
 * duplicate, no more than the list holds, no key they cannot spend - before it
 * is stored, and a reset goes back to the deployment's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FALLBACKS_MOST, POLAR_ROUTING_DEFAULTS } from "@/lib/polar/routing";

const OWN_KEY = "0190a3c2-7a3e-7000-8000-000000000001";
const SHARED_KEY = "0190a3c2-7a3e-7000-8000-000000000002";
const FOREIGN_KEY = "0190a3c2-7a3e-7000-8000-000000000009";

const state = {
    saved: [] as unknown[],
    viewingAs: false,
    use: true
};

vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "user-1", viewingAs: state.viewingAs ? "other" : null })
}));
vi.mock("@/lib/polar/access", () => ({
    polarAccessFor: async () => ({ use: state.use, spend: true, web: true, connectors: false })
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/polar/router/store", () => ({
    setOwnRouting: async (_userId: string, routing: unknown) => void state.saved.push(routing)
}));
vi.mock("@/lib/polar/routing-screen", () => ({
    routingScreenFor: async () => ({
        own: null,
        deployment: POLAR_ROUTING_DEFAULTS,
        keys: [
            { id: OWN_KEY, provider: "anthropic", name: "Mine", source: "own" },
            { id: SHARED_KEY, provider: "openai", name: "Team", source: "instance" }
        ]
    }),
    routingUsageFor: vi.fn()
}));

const { resetRoutingAction, saveRoutingAction } = await import(
    "@/app/(app)/polar/settings/routing-actions"
);

const entry = (model: string, keyId: string | null = null, provider = "anthropic") => ({
    provider,
    model,
    reasoning: "inherit",
    keyId
});

beforeEach(() => {
    state.saved = [];
    state.viewingAs = false;
    state.use = true;
});

describe("saveRoutingAction", () => {
    it("stores a routing pinning the person's own and the shared keys", async () => {
        const result = await saveRoutingAction({
            fallbacks: [entry("claude-a", OWN_KEY), entry("gpt-a", SHARED_KEY, "openai")]
        });
        expect(result).toEqual({});
        expect(state.saved).toHaveLength(1);
    });

    it("refuses the same model on the same key twice", async () => {
        const result = await saveRoutingAction({
            fallbacks: [entry("claude-a", OWN_KEY), entry("claude-a", OWN_KEY)]
        });
        expect(result).toEqual({ error: "routing.errors.duplicate" });
        expect(state.saved).toEqual([]);
    });

    it("allows the same model on another key", async () => {
        const result = await saveRoutingAction({
            fallbacks: [entry("claude-a", OWN_KEY), entry("claude-a")]
        });
        expect(result).toEqual({});
    });

    it("refuses more fallbacks than the list holds", async () => {
        const fallbacks = Array.from({ length: FALLBACKS_MOST + 1 }, (_, index) =>
            entry(`model-${index}`)
        );
        expect(await saveRoutingAction({ fallbacks })).toEqual({
            error: "routing.errors.tooMany"
        });
    });

    it("refuses a key the person cannot spend, or one of another provider", async () => {
        expect(await saveRoutingAction({ fallbacks: [entry("claude-a", FOREIGN_KEY)] })).toEqual({
            error: "routing.errors.key"
        });
        expect(await saveRoutingAction({ fallbacks: [entry("claude-a", SHARED_KEY)] })).toEqual({
            error: "routing.errors.key"
        });
        expect(
            await saveRoutingAction({ tiers: { opus: entry("claude-a", FOREIGN_KEY) } })
        ).toEqual({ error: "routing.errors.key" });
        expect(state.saved).toEqual([]);
    });

    it("refuses a malformed routing", async () => {
        expect(await saveRoutingAction({ fallbacks: [{ provider: "x" }] })).toEqual({
            error: "routing.errors.invalid"
        });
    });

    it("writes nothing while viewing as someone else, or without Polar", async () => {
        state.viewingAs = true;
        expect(await saveRoutingAction({})).toEqual({ error: "routing.errors.viewingAs" });
        state.viewingAs = false;
        state.use = false;
        expect(await saveRoutingAction({})).toEqual({ error: "routing.errors.noAccess" });
        expect(state.saved).toEqual([]);
    });
});

describe("resetRoutingAction", () => {
    it("goes back to the deployment's routing", async () => {
        expect(await resetRoutingAction()).toEqual({});
        expect(state.saved).toEqual([null]);
    });
});
