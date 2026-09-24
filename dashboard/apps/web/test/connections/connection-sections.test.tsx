/**
 * Connected accounts lists the accounts most people link first, and the ones for
 * building and shipping under a "Developers" heading below them.
 *
 * Which section a service belongs to is data on the provider catalogue rather
 * than a list in the screen, so these check the catalogue says it, that the split
 * keeps both the section order and each provider's place, and that the screen
 * draws what the split returns.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CONNECTION_PROVIDERS, connectionSections } from "@polaris/core";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("../../src/app/(app)/account/connections/actions", () => ({
    connectAwsAction: async () => ({}),
    connectTokenAction: async () => ({}),
    disconnectAccountAction: async () => ({}),
    saveMinecraftNameAction: async () => ({})
}));

const { ConnectionsView } = await import("../../src/app/(app)/account/connections/connections-view");

type Card = Parameters<typeof ConnectionsView>[0]["providers"][number];

/** The screen's card for every provider in the catalogue, nothing linked. */
function cards(): Card[] {
    return CONNECTION_PROVIDERS.map((provider) => ({
        slug: provider.slug,
        name: provider.name,
        category: provider.category,
        summary: provider.summary,
        description: provider.description,
        acceptsToken: provider.acceptsToken,
        requires: provider.requires,
        limit: 1,
        canAuthorize: false,
        canSignIn: false,
        accounts: []
    })) as Card[];
}

describe("which section a service is listed under", () => {
    it("puts the building and shipping services under Developers", () => {
        const developer = CONNECTION_PROVIDERS.filter((provider) => provider.category === "developer")
            .map((provider) => provider.slug)
            .sort();
        expect(developer).toEqual(["aws", "github", "railway", "vercel"]);
    });

    it("keeps everything else in the general section", () => {
        const general = CONNECTION_PROVIDERS.filter((provider) => provider.category === "general")
            .map((provider) => provider.slug)
            .sort();
        expect(general).toEqual(["discord", "dropbox", "epic", "google", "microsoft", "minecraft", "steam"]);
    });

    it("lists the general section first and keeps each provider's place in its own", () => {
        const sections = connectionSections(cards());
        expect(sections.map((section) => section.label)).toEqual(["General", "Developers"]);
        expect(sections[0]?.providers.map((provider) => provider.slug)).toEqual([
            "google",
            "microsoft",
            "steam",
            "epic",
            "minecraft",
            "discord",
            "dropbox"
        ]);
        expect(sections[1]?.providers.map((provider) => provider.slug)).toEqual(["github", "vercel", "railway", "aws"]);
    });

    it("draws no heading over a section with nothing in it", () => {
        const sections = connectionSections(cards().filter((card) => card.category === "general"));
        expect(sections.map((section) => section.id)).toEqual(["general"]);
    });
});

describe("the screen", () => {
    it("shows the general accounts above the Developers heading", () => {
        const html = renderToStaticMarkup(<ConnectionsView providers={cards()} />);
        const general = html.indexOf(">General</h2>");
        const developers = html.indexOf(">Developers</h2>");
        expect(general).toBeGreaterThan(-1);
        expect(developers).toBeGreaterThan(general);
        expect(html.indexOf(">Google</h3>")).toBeLessThan(developers);
        expect(html.indexOf(">GitHub</h3>")).toBeGreaterThan(developers);
        expect(html.indexOf(">AWS</h3>")).toBeGreaterThan(developers);
    });

    it("draws the AWS card with the AWS mark rather than the generic block", () => {
        const aws = cards().filter((card) => card.slug === "aws");
        const html = renderToStaticMarkup(<ConnectionsView providers={aws} />);
        // The smile, in AWS's own orange.
        expect(html).toContain("#FF9900");
    });
});
