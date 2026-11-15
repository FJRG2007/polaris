/**
 * The provider picker's rows: what the server action answers each page with.
 * The picker itself is the shared async select, tested in @polaris/ui; what is
 * specific here is that a row carries its free tier and its own name.
 */

import { describe, expect, it } from "vitest";
import { MODEL_PROVIDER_SEEDS } from "@/lib/integrations/model-providers";
import { modelProviderName, providerRow } from "@/lib/agents/model-key-providers";

describe("the provider list", () => {
    it("badges the providers a key can be had from for nothing", () => {
        const free = MODEL_PROVIDER_SEEDS.find((seed) => seed.free);
        expect(free).toBeDefined();
        expect(providerRow(free!.slug).freeTier?.kind).toBe(free!.free!.kind);
    });

    it("says nothing about a provider that bills from the first token", () => {
        expect(providerRow("openai").freeTier).toBeNull();
    });

    it("names a provider the snapshot has not read yet from the hit", () => {
        const row = providerRow("brand-new", { name: "Brand New", freeTier: null });
        expect(row.name).toBe("Brand New");
        expect(modelProviderName("brand-new")).toBe("brand-new");
    });
});
