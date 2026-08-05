/**
 * Every card in the catalog opens something.
 *
 * The marketplace renders a Set up button for whatever the catalog lists, and
 * the dialog behind it is chosen separately - so an entry added to one and not
 * the other ships a button that does nothing at all. That is what happened to
 * the model providers: five cards on screen, no way to connect any of them, and
 * nothing to see in a log because clicking simply had no effect.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { INTEGRATIONS } from "@/lib/integrations/registry";
import type { IntegrationCard } from "../../src/app/(app)/integrations/integrations-view";

// The dialogs call the page's server actions, which reach the database on import.
vi.mock("../../src/app/(app)/integrations/actions", () => ({}));

const { dialogFor, IntegrationsView } = await import("../../src/app/(app)/integrations/integrations-view");

/** A card as the pages build one: catalog entry, nothing configured yet. */
function card(slug: string): IntegrationCard {
    const entry = INTEGRATIONS.find((candidate) => candidate.slug === slug);
    if (!entry) throw new Error(`no catalog entry for ${slug}`);
    return {
        slug: entry.slug,
        name: entry.name,
        category: entry.category,
        summary: entry.summary,
        description: entry.description,
        docsUrl: entry.docsUrl,
        setupLinks: entry.setupLinks,
        requiresApiKey: entry.requiresApiKey,
        apiKeyLabel: entry.apiKeyLabel,
        apiKeyHelp: entry.apiKeyHelp,
        enabled: false,
        hasSecret: false,
        gateway: entry.slug === "enigma" ? { baseUrl: "", model: "", context: 0, maxOutput: 0 } : undefined,
        scanDropPoints: true,
        onDetection: "block",
        verifyAccessIp: true,
        deny: []
    };
}

describe("the configure dialogs", () => {
    it("covers every integration in the catalog", () => {
        const dead = INTEGRATIONS.filter((entry) => dialogFor(card(entry.slug)) === null).map((entry) => entry.slug);
        expect(dead).toEqual([]);
    });

    it("sends the gateway somewhere else than the providers", () => {
        expect(dialogFor(card("enigma"))).not.toBe(dialogFor(card("anthropic")));
    });

    it("gives every model provider the same dialog, since connecting one is the same job", () => {
        const providers = INTEGRATIONS.filter((entry) => entry.category === "Models" && entry.slug !== "enigma");
        const dialogs = new Set(providers.map((entry) => dialogFor(card(entry.slug))));
        expect(dialogs.size).toBe(1);
    });
});

describe("the AI providers screen", () => {
    it("lists every model provider with a way in", () => {
        const models = INTEGRATIONS.filter((entry) => entry.category === "Models");
        const markup = renderToStaticMarkup(<IntegrationsView cards={models.map((entry) => card(entry.slug))} />);
        for (const entry of models) expect(markup).toContain(entry.name);
        expect(markup.match(/Set up/g)?.length).toBe(models.length);
    });
});
