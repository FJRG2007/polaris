/**
 * The Models catalog and the run environment have to agree.
 *
 * They are two lists in two files - what an operator can connect, and what a run
 * is handed - and every mismatch between them fails silently in the direction
 * nobody checks: a provider offered on the screen whose key never reaches a run,
 * or a default model whose prefix routes to a credential Polaris never sends.
 * Both look like a working setup until a run asks for a key that is not there.
 */

import { describe, expect, it, vi } from "vitest";

// The provider list lives beside the code that reads stored keys, so importing it
// pulls in the database client. Nothing here touches it.
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationSecret: async () => null,
    listIntegrationStates: async () => new Map()
}));

const { MODEL_PROVIDERS, GATEWAY_SLUG, providerForModel } = await import("../../src/lib/agents/agent-providers");
const { MODEL_INTEGRATIONS, readGatewayConfig } = await import("../../src/lib/integrations/registry");

describe("the Models catalog", () => {
    it("gives every provider on the screen a place in the run environment", () => {
        const wired = new Set([...MODEL_PROVIDERS.map((provider) => provider.slug), GATEWAY_SLUG]);
        const orphans = MODEL_INTEGRATIONS.filter((entry) => !wired.has(entry.slug)).map((entry) => entry.slug);
        expect(orphans).toEqual([]);
    });

    it("offers a card for every provider a run can be handed a key for", () => {
        const listed = new Set(MODEL_INTEGRATIONS.map((entry) => entry.slug));
        const hidden = MODEL_PROVIDERS.filter((provider) => !listed.has(provider.slug)).map((provider) => provider.slug);
        expect(hidden).toEqual([]);
    });

    it("reads each key from its own environment variable", () => {
        const vars = MODEL_PROVIDERS.map((provider) => provider.envVar);
        expect(new Set(vars).size).toBe(vars.length);
    });

    it("routes each default model to the key that provider contributes", () => {
        for (const entry of MODEL_INTEGRATIONS) {
            if (!entry.defaultModel || entry.slug === GATEWAY_SLUG) continue;
            expect(providerForModel(entry.defaultModel.slug)?.slug, entry.slug).toBe(entry.slug);
        }
    });

    it("gives the gateway a model of its own, since no catalog covers it", () => {
        const gateway = MODEL_INTEGRATIONS.find((entry) => entry.slug === GATEWAY_SLUG);
        expect(gateway?.defaultModel?.slug).toBe("openai-compatible/byok");
        // Deliberately outside providerForModel: the gateway carries a base URL,
        // not a provider key, so no MODEL_PROVIDERS entry should claim it.
        expect(providerForModel("openai-compatible/byok")).toBeNull();
    });
});

describe("the gateway settings", () => {
    it("treats a missing or nonsense limit as unset rather than as a number", () => {
        expect(readGatewayConfig(undefined)).toEqual({ baseUrl: "", model: "", context: 0, maxOutput: 0 });
        expect(readGatewayConfig({ context: "128k", maxOutput: -1 })).toMatchObject({ context: 0, maxOutput: 0 });
    });

    it("keeps what was stored", () => {
        expect(readGatewayConfig({ baseUrl: "https://gw/v1", model: "big", context: 200000, maxOutput: 64000 })).toEqual({
            baseUrl: "https://gw/v1",
            model: "big",
            context: 200000,
            maxOutput: 64000
        });
    });
});
