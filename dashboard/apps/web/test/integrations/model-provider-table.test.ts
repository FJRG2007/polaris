/**
 * The table the long tail of model providers is written in.
 *
 * It is read three times - what the marketplace lists, what a run is handed, and
 * where a pasted key is checked - so a row that is wrong is wrong in three
 * places at once, and every one of those failures is silent. A provider whose
 * prefix does not match its slug routes runs to a credential Polaris never
 * sends; a check endpoint pointed at a public model list "verifies" every string
 * ever pasted, which is worse than not checking at all.
 *
 * What is not asserted here is that the providers exist, which no test can know.
 * Each row's environment variable, prefix and documentation link came from the
 * public index the agent runtimes resolve model ids against, and each endpoint
 * was asked, without a key, whether it refuses one.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationSecret: async () => null,
    listIntegrationStates: async () => new Map()
}));

const { MODEL_PROVIDER_SEEDS, SEEDED_MODEL_INTEGRATIONS } = await import("../../src/lib/integrations/model-providers");
const { MODEL_PROVIDERS } = await import("../../src/lib/agents/agent-providers");
const { providerIsCheckable } = await import("../../src/lib/agents/provider-key-check");

describe("the model provider table", () => {
    it("names each provider once", () => {
        const slugs = MODEL_PROVIDER_SEEDS.map((seed) => seed.slug);
        expect(new Set(slugs).size).toBe(slugs.length);
    });

    it("gives each one an environment variable no other provider claims", () => {
        // Across the whole list, not just the table: two providers sharing a
        // variable means the second key silently overwrites the first, and the
        // one that loses is whichever happens to be second in the array.
        const vars = MODEL_PROVIDERS.map((provider) => provider.envVar);
        expect(new Set(vars).size).toBe(vars.length);
    });

    it("routes each default model back to the provider that offers it", () => {
        for (const seed of MODEL_PROVIDER_SEEDS) {
            expect(seed.defaultModel.slug.split("/")[0], seed.slug).toBe(seed.slug);
        }
    });

    it("only claims a key can be checked where there is somewhere to check it", () => {
        for (const seed of MODEL_PROVIDER_SEEDS) {
            expect(providerIsCheckable(seed.slug), seed.slug).toBe(Boolean(seed.probe));
        }
    });

    it("asks over https, since the key rides in the request", () => {
        for (const seed of MODEL_PROVIDER_SEEDS) {
            for (const url of [seed.probe, seed.keyUrl, seed.docsUrl].filter(Boolean)) {
                expect(url, seed.slug).toMatch(/^https:\/\//);
            }
        }
    });

    it("says what a free tier is rather than quoting a number that will move", () => {
        for (const seed of MODEL_PROVIDER_SEEDS) {
            if (!seed.free) continue;
            expect(["free", "trial"], seed.slug).toContain(seed.free.kind);
            expect(seed.free.note.length, seed.slug).toBeGreaterThan(0);
            // A quota written down here is one nothing can correct when the
            // provider changes it, and it reads as fact for as long as it stands.
            expect(seed.free.note, seed.slug).not.toMatch(/\d[\d,.]*\s*(k|m|b)?\s*(tokens|requests|calls|rpm|rpd|tpm)/i);
        }
    });

    it("carries the free tier through to the marketplace entry", () => {
        const free = MODEL_PROVIDER_SEEDS.filter((seed) => seed.free).map((seed) => seed.slug);
        const carried = SEEDED_MODEL_INTEGRATIONS.filter((entry) => entry.freeTier).map((entry) => entry.slug);
        expect(carried).toEqual(free);
    });

    it("writes every entry a summary and a description of its own", () => {
        for (const entry of SEEDED_MODEL_INTEGRATIONS) {
            expect(entry.summary.length, entry.slug).toBeGreaterThan(0);
            expect(entry.description, entry.slug).toContain(entry.name);
            expect(entry.requiresApiKey, entry.slug).toBe(true);
        }
    });
});
