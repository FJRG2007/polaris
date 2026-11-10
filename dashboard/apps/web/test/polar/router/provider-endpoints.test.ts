/**
 * Polar reaches every catalogue provider whose chat endpoint is known, not
 * only the nine it started with, and talks to each in its own wire format.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/polar/access", () => ({
    polarAccessFor: async () => ({ use: true, spend: false }),
    polarKeySources: async () => new Map(),
    polarCredentialFor: async () => null,
    polarCredentialsFor: async () => []
}));
vi.mock("@/lib/agents/model-catalog", () => ({ listCatalogModels: async () => [] }));
import { PROVIDER_ENDPOINTS } from "@/lib/polar/provider-endpoints";
import { MODEL_PROVIDER_SEEDS } from "@/lib/integrations/model-providers";

const { polarServesProvider, languageModel } = await import("@/lib/polar/models");

const credential = (provider: string) => ({
    provider,
    source: "own" as const,
    secret: "key",
    baseUrl: null,
    gatewayModel: null
});

describe("the providers Polar can call", () => {
    it("serves every provider it has an endpoint for, and each is a catalogue provider", () => {
        const seeded = new Set(MODEL_PROVIDER_SEEDS.map((seed) => seed.slug));
        for (const slug of Object.keys(PROVIDER_ENDPOINTS)) {
            expect(seeded.has(slug), slug).toBe(true);
            expect(polarServesProvider(slug), slug).toBe(true);
        }
        expect(Object.keys(PROVIDER_ENDPOINTS).length).toBeGreaterThan(40);
    });

    it("keeps every endpoint on https with no trailing slash", () => {
        for (const [slug, endpoint] of Object.entries(PROVIDER_ENDPOINTS)) {
            expect(endpoint.baseUrl, slug).toMatch(/^https:\/\/[^\s]+[^/]$/);
        }
    });

    it("builds a client in the provider's own format", () => {
        expect(languageModel(credential("nvidia"), "meta/llama").provider).toContain("nvidia");
        expect(languageModel(credential("minimax"), "MiniMax-M3").provider).toContain("anthropic");
        expect(languageModel(credential("mistral"), "mistral-medium").provider).toContain("mistral");
    });

    it("still refuses a provider it has no way to reach", () => {
        expect(polarServesProvider("cohere")).toBe(false);
        expect(() => languageModel(credential("cohere"), "command")).toThrow();
    });
});
