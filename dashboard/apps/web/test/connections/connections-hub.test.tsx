/**
 * Connected accounts as the one place a person links an outside account: a list
 * that stays usable with many services (search, one section at a time, the ones
 * in use first), a card an app can point at, and the way back to that app.
 */

import { withMessages } from "../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { CONNECTION_PROVIDERS } from "@polaris/core";
import { renderToStaticMarkup } from "react-dom/server";
import { arrangeProviders } from "../../src/lib/connections/arrange";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
vi.mock("../../src/app/(app)/account/connections/actions", () => ({
    connectAwsAction: async () => ({}),
    connectTokenAction: async () => ({}),
    disconnectAccountAction: async () => ({}),
    saveLastfmNameAction: async () => ({}),
    saveMinecraftNameAction: async () => ({})
}));

const { ConnectionsView, linkHref, readReturnTo } = await import(
    "../../src/app/(app)/account/connections/connections-view"
);

type Card = Parameters<typeof ConnectionsView>[0]["providers"][number];

const linkedAt = new Date("2026-01-01T00:00:00Z");

/** Every provider in the catalogue, with an account linked for `linked`. */
function cards(linked: string[] = []): Card[] {
    return CONNECTION_PROVIDERS.map((provider) => ({
        slug: provider.slug,
        name: provider.name,
        category: provider.category,
        summary: provider.summary,
        description: provider.description,
        acceptsToken: provider.acceptsToken,
        requires: provider.requires,
        limit: 1,
        canAuthorize: true,
        canSignIn: false,
        accounts: linked.includes(provider.slug)
            ? [
                  {
                      id: `${provider.slug}-1`,
                      provider: provider.slug,
                      label: `${provider.slug}-account`,
                      avatarUrl: null,
                      method: "oauth",
                      scope: null,
                      signsIn: false,
                      createdAt: linkedAt,
                      needsReauthorization: false,
                      missingScopes: []
                  }
              ]
            : []
    })) as unknown as Card[];
}

describe("arranging the list", () => {
    it("puts the connected services first in each section, keeping catalogue order", () => {
        const sections = arrangeProviders(cards(["spotify", "vercel"]));
        const general = sections.find((section) => section.id === "general")!;
        const developer = sections.find((section) => section.id === "developer")!;
        expect(general.providers[0]?.slug).toBe("spotify");
        expect(general.providers.slice(1, 3).map((p) => p.slug)).toEqual(["google", "microsoft"]);
        expect(developer.providers.map((p) => p.slug)).toEqual([
            "vercel",
            "github",
            "railway",
            "aws"
        ]);
    });

    it("narrows to one section", () => {
        const sections = arrangeProviders(cards(), { category: "developer" });
        expect(sections.map((section) => section.id)).toEqual(["developer"]);
    });

    it("searches the name and slug, ignoring case and accents", () => {
        const sections = arrangeProviders(cards(), { query: "  GÍTHUB " });
        expect(sections.flatMap((s) => s.providers.map((p) => p.slug))).toEqual(["github"]);
        expect(arrangeProviders(cards(), { query: "zzz-nothing" })).toEqual([]);
    });
});

describe("the way back to the app that sent somebody here", () => {
    it("keeps a path on this origin and refuses anything that leaves it", () => {
        expect(readReturnTo("?return=%2Fapps%2Fdeploy%3Fx%3D1")).toBe("/apps/deploy?x=1");
        expect(readReturnTo("?return=https%3A%2F%2Fevil.example")).toBeNull();
        expect(readReturnTo("?return=%2F%5Cevil.example")).toBeNull();
        expect(readReturnTo("?return=%2F%2Fevil.example")).toBeNull();
        expect(readReturnTo("")).toBeNull();
    });

    it("carries the way back on the Connect trip", () => {
        expect(linkHref("vercel", null)).toBe("/api/connections/vercel/link");
        expect(linkHref("vercel", "/apps/deploy")).toBe(
            "/api/connections/vercel/link?return=%2Fapps%2Fdeploy"
        );
    });

    it("offers the back button and marks the service the app pointed at", () => {
        const html = renderToStaticMarkup(
            withMessages(
                <ConnectionsView
                    providers={cards()}
                    initialSearch="provider=vercel&return=%2Fapps%2Fdeploy"
                />
            )
        );
        expect(html).toContain('href="/apps/deploy"');
        expect(html).toContain("Back to where you were");
        expect(html).toMatch(/id="connection-vercel"[^>]*data-focused=""/);
        expect(html).not.toMatch(/id="connection-github"[^>]*data-focused/);
    });

    it("draws no back button when nothing sent somebody here", () => {
        const html = renderToStaticMarkup(withMessages(<ConnectionsView providers={cards()} />));
        expect(html).not.toContain("Back to where you were");
        expect(html).toContain('aria-label="Search services"');
        expect(html).toContain('aria-pressed="true"');
    });
});
