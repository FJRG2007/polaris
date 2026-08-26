/**
 * Every card in the marketplace opens something.
 *
 * The marketplace renders a Set up button for whatever the catalog lists, and
 * the dialog behind it is chosen separately - so an entry added to one and not
 * the other ships a button that does nothing at all. That is what happened to
 * the model providers: five cards on screen, no way to connect any of them, and
 * nothing to see in a log because clicking simply had no effect.
 *
 * The model providers have since left the grid entirely - they are a list of
 * keys now, on their own screen - so the rule these keep is the same one from
 * the other side: a card the marketplace shows opens a dialog, and a model
 * provider is never one of those cards.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GATEWAY_SLUG } from "@/lib/agents/agent-providers";
import { modelProviderRows } from "@/lib/agents/model-key-providers";
import { MODEL_INTEGRATIONS, SERVICE_INTEGRATIONS } from "@/lib/integrations/registry";
import type { IntegrationCard } from "../../src/app/(app)/admin/integrations/integrations-view";

// The dialogs call the page's server actions, which reach the database on import.
vi.mock("../../src/app/(app)/admin/integrations/actions", () => ({}));

// The grid asks the router to re-read the cards when a dialog closes, and there is
// no mounted router in a static render.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const { dialogFor, IntegrationsView } = await import("../../src/app/(app)/admin/integrations/integrations-view");

/** A card as the page builds one: catalog entry, nothing configured yet. */
function card(slug: string): IntegrationCard {
    const entry = SERVICE_INTEGRATIONS.find((candidate) => candidate.slug === slug);
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
        scanDropPoints: true,
        onDetection: "block",
        verifyAccessIp: true,
        deny: []
    };
}

describe("the configure dialogs", () => {
    it("covers every integration the marketplace lists", () => {
        const dead = SERVICE_INTEGRATIONS.filter((entry) => dialogFor(card(entry.slug)) === null).map(
            (entry) => entry.slug
        );
        expect(dead).toEqual([]);
    });

    it("keeps the model providers out of the grid", () => {
        // They are keys in a list on their own screen. A model card here would
        // be a card with nothing behind its button.
        expect(SERVICE_INTEGRATIONS.filter((entry) => entry.category === "Models")).toEqual([]);
    });

    it("renders a way in for every card it is given", () => {
        const markup = renderToStaticMarkup(
            <IntegrationsView cards={SERVICE_INTEGRATIONS.map((entry) => card(entry.slug))} />
        );
        for (const entry of SERVICE_INTEGRATIONS) expect(markup).toContain(entry.name);
        expect(markup.match(/Set up/g)?.length).toBe(SERVICE_INTEGRATIONS.length);
    });
});

describe("the AI providers screen", () => {
    it("offers a key for every model provider in the catalog", () => {
        // Both screens that add a key read this one list, so a provider missing
        // here is a provider nobody can bring a key for.
        expect(modelProviderRows().map((row) => row.slug)).toEqual(MODEL_INTEGRATIONS.map((entry) => entry.slug));
    });

    it("marks the gateway, and only the gateway", () => {
        // It is the row that asks for an endpoint and a model as well as a token,
        // and the one whose token may be left out altogether.
        const gateways = modelProviderRows().filter((row) => row.isGateway);
        expect(gateways.map((row) => row.slug)).toEqual([GATEWAY_SLUG]);
    });
});
