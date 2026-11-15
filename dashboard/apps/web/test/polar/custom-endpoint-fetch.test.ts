/**
 * A chat sent to an endpoint the catalogue store holds - an operator's own
 * provider, or one the public index added - is made through the guarded fetch,
 * so its name is checked where it resolves on every call. The endpoints written
 * into the code keep the library's own fetch.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@ai-sdk/openai-compatible", () => ({
    createOpenAICompatible: (settings: Record<string, unknown>) => {
        made.push(settings);
        return (model: string) => ({ model });
    }
}));
vi.mock("@ai-sdk/anthropic", () => ({
    createAnthropic: (settings: Record<string, unknown>) => {
        made.push(settings);
        return (model: string) => ({ model });
    }
}));

// Nothing here reads the database; the model module only imports it.
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/session", () => ({ requireUser: vi.fn(), getSession: vi.fn() }));

const { languageModel, catalogAddressed } = await import("@/lib/polar/models");
const snapshot = await import("@/lib/integrations/provider-catalog-snapshot");

function row(
    slug: string,
    source: snapshot.CatalogSource,
    wire: "openai" | "anthropic" = "openai"
): snapshot.CatalogProvider {
    return {
        slug,
        name: slug,
        kind: "listed",
        envVar: `${slug.toUpperCase()}_API_KEY`,
        summary: "Test endpoint.",
        docsUrl: "https://endpoint.example/docs",
        defaultModel: { label: "m", slug: `${slug}/m` },
        outsideIndex: true,
        baseUrl: "https://endpoint.example/v1",
        wire,
        source
    };
}

const credential = (provider: string) => ({
    provider,
    secret: "sk-test",
    source: "own" as const,
    baseUrl: null,
    gatewayModel: null
});

afterEach(() => {
    snapshot.replaceCatalogProviders([]);
    made.length = 0;
});

describe("the fetch a chat to a provider's endpoint is made with", () => {
    it("is the guarded one for an operator's own endpoint, on either wire", () => {
        snapshot.replaceCatalogProviders([row("mine", "custom"), row("mine-a", "custom", "anthropic")]);
        expect(catalogAddressed("mine")).toBe(true);
        languageModel(credential("mine"), "m");
        languageModel(credential("mine-a"), "m");
        expect(made).toHaveLength(2);
        for (const settings of made) expect(typeof settings.fetch).toBe("function");
    });

    it("is the guarded one for an endpoint the index added", () => {
        snapshot.replaceCatalogProviders([row("listed", "index")]);
        languageModel(credential("listed"), "m");
        expect(typeof made[0]?.fetch).toBe("function");
    });

    it("is the library's own for an endpoint written into the code", () => {
        expect(catalogAddressed("openrouter")).toBe(false);
        languageModel(credential("openrouter"), "m");
        expect(made[0]?.fetch).toBeUndefined();
    });
});
