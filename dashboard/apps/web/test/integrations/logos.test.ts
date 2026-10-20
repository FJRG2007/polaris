/**
 * Every integration in the catalogue has a logo of its own.
 *
 * The fallback is a generic block, and a generic block is indistinguishable from
 * a logo that failed to load: a card whose whole job is to be recognised at a
 * glance instead reads as one that is broken. Six of them were drawing it -
 * Criminal IP, Minecraft, Krisp, Tenor, Giphy and the gateway - and nothing said
 * so, because a missing entry in a map is not an error anywhere.
 *
 * This is the check that makes adding an integration without its mark fail here
 * rather than on the screen.
 */

import { createElement } from "react";
import { AGENT_CLIS } from "@polaris/core";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentLogo, IntegrationLogo, hasIntegrationLogo } from "@/components/logos";
import { MODEL_PROVIDER_SEEDS } from "@/lib/integrations/model-providers";
import { INTEGRATIONS } from "@/lib/integrations/registry";
import { DEVICE_CONNECTIONS } from "@polaris-app/places/src/lib/device-connections";

describe("integration logos", () => {
    it("covers every entry in the catalogue", () => {
        const missing = INTEGRATIONS.filter((entry) => !hasIntegrationLogo(entry.slug)).map(
            (entry) => entry.slug
        );
        expect(missing).toEqual([]);
    });

    it("covers every make Places can connect", () => {
        // A make's picker tile draws its logo by slug; one missing here is a
        // brand drawn as the generic block. An empty slug is the deliberate
        // "not a brand" of a protocol-level connection.
        const missing = DEVICE_CONNECTIONS.filter(
            (entry) => entry.logo && !hasIntegrationLogo(entry.logo)
        ).map((entry) => entry.logo);
        expect(missing).toEqual([]);
    });

    it("does not claim one for something that is not in the catalogue", () => {
        // The map is keyed by slug and nothing checks the spelling, so a typo
        // would otherwise be a logo registered for an integration that does not
        // exist while the real one draws the block.
        expect(hasIntegrationLogo("not-an-integration")).toBe(false);
    });
});

/**
 * The providers and agents with no official mark that could be sourced (the
 * vendor's own file, Simple Icons, svgl or an Iconify logo set). Everything else
 * in the seeded table and the agent catalogue must draw its mark, so a mark that
 * stops being wired - or one added without leaving this list - fails here.
 */
const MONOGRAM_PROVIDERS = [
    "cohere",
    "venice",
    "sarvam",
    "chutes",
    "tinfoil",
    "gmicloud",
    "io-net",
    "berget",
    "requesty",
    "zenmux",
    "nano-gpt",
    "llmgateway",
    "helicone",
    "fastrouter",
    "anyapi",
    "unorouter",
    "orcarouter",
    "synthetic",
    "cortecs",
    "edenai"
];
const MONOGRAM_AGENTS = ["amp", "aider", "droid", "crush"];

/** A monogram is the one logo drawn as a tinted span of letters. */
function isMonogram(markup: string): boolean {
    return markup.startsWith("<span");
}

describe("provider and agent logos", () => {
    it.each(MODEL_PROVIDER_SEEDS.map((seed) => seed.slug))("provider %s", (slug) => {
        const markup = renderToStaticMarkup(createElement(IntegrationLogo, { slug }));
        expect(isMonogram(markup)).toBe(MONOGRAM_PROVIDERS.includes(slug));
    });

    it.each(AGENT_CLIS.map((cli) => [cli.id, cli.label]))("agent %s", (id, label) => {
        const markup = renderToStaticMarkup(createElement(AgentLogo, { id, label }));
        expect(isMonogram(markup)).toBe(MONOGRAM_AGENTS.includes(id));
    });

    it("lists only slugs that exist", () => {
        const seeds = new Set(MODEL_PROVIDER_SEEDS.map((seed) => seed.slug));
        const agents = new Set(AGENT_CLIS.map((cli) => cli.id));
        expect(MONOGRAM_PROVIDERS.filter((slug) => !seeds.has(slug))).toEqual([]);
        expect(MONOGRAM_AGENTS.filter((id) => !agents.has(id))).toEqual([]);
    });

    it("keeps the monogram for a slug nobody knows", () => {
        const markup = renderToStaticMarkup(
            createElement(AgentLogo, { id: "some-new-agent", label: "Some New Agent" })
        );
        expect(isMonogram(markup)).toBe(true);
    });
});
