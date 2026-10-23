/**
 * The site's data builders over fixtures: the catalogue to marketplace entries,
 * the README to the "replaces" table and the screenshots, and the OpenAPI
 * document to the reference.
 */

import { describe, expect, it } from "vitest";
import * as site from "../../src/data/builders";

const app = (id: string, extra: Partial<site.SiteApp> = {}): site.SiteApp => ({
    id,
    name: id.toUpperCase(),
    category: "Tools",
    categoryLabel: "Tools",
    summary: `${id} summary`,
    description: `${id} description`,
    keywords: [],
    comingSoon: false,
    mark: "<svg></svg>",
    markLarge: "<svg></svg>",
    logo: null,
    tint: "#123456",
    ink: "#ffffff",
    byline: "By Polaris",
    alt: `${id} preview`,
    shot: null,
    shelf: "polaris",
    featured: false,
    added: null,
    capabilities: [],
    consent: null,
    needs: [],
    facts: [],
    shots: [],
    replaces: [],
    games: [],
    ...extra
});

describe("filterSiteApps", () => {
    const apps = [
        app("chat", { category: "Messaging", added: "2026-01-02" }),
        app("notes", { name: "Bloc", added: "2026-03-04" }),
        app("soon", { comingSoon: true, added: "2026-09-09" }),
        app("ark", { shelf: "community" })
    ];
    const filter = (extra: Partial<Parameters<typeof site.filterSiteApps>[1]>) =>
        site
            .filterSiteApps(apps, { query: "", category: "", sort: "featured", locale: "en", ...extra })
            .map((entry) => entry.id);

    it("keeps the dashboard's order, with anything not out yet last", () => {
        expect(filter({})).toEqual(["chat", "notes", "ark", "soon"]);
    });

    it("sorts by name and by the day an app was added, as the dashboard does", () => {
        expect(filter({ sort: "name" })).toEqual(["ark", "notes", "chat", "soon"]);
        expect(filter({ sort: "recent" })).toEqual(["notes", "chat", "ark", "soon"]);
    });

    it("searches and filters by category", () => {
        expect(filter({ query: "cha" })).toEqual(["chat"]);
        expect(filter({ category: "Messaging" })).toEqual(["chat"]);
        expect(site.siteCategories(apps).map((entry) => entry.id)).toEqual(["Messaging", "Tools"]);
    });

    it("splits the shelves Polaris's first and leaves an empty one out", () => {
        expect(site.siteShelves(apps).map((group) => group.shelf)).toEqual(["polaris", "community"]);
        expect(site.siteShelves([apps[3]!]).map((group) => group.shelf)).toEqual(["community"]);
    });
});

const README = `
## If you already pay for these

What Polaris replaces:

| What you use today | What Polaris runs instead |
| ------------------ | ------------------------- |
| Railway, Render, Fly | Deploy from a repository |
| Bitwarden and 1Password | A vault |

## Install

curl -fsSL https://example.test/install.sh | sh
irm https://example.test/install.ps1 | iex

### Talk

<table><tr>
<td><picture>
<source media="(prefers-color-scheme: light)" srcset="docs/assets/media/chat-light-en-desktop.webp">
<img src="docs/assets/media/chat-dark-en-desktop.webp" alt="Chat: spaces">
</picture>
<br><sub><a href="docs/features/chat.md"><b>Chat</b></a>: spaces and threads</sub></td>
</tr></table>

## Next
`;

describe("README", () => {
    it("reads the replaces table with the logos the repository has", () => {
        const rows = site.parseReplaces(
            README,
            /already pay/i,
            new Set(["railway.svg", "bitwarden.svg", "1password.svg"])
        );
        expect(rows).toHaveLength(2);
        expect(rows[0]!.tools).toEqual([
            { name: "Railway", logo: "railway.svg" },
            { name: "Render", logo: null },
            { name: "Fly", logo: null }
        ]);
        expect(rows[1]!.tools.map((tool) => tool.logo)).toEqual(["bitwarden.svg", "1password.svg"]);
        expect(rows[1]!.instead).toBe("A vault");
    });

    it("finds no table under a heading that is not there", () => {
        expect(site.parseReplaces(README, /nope/, new Set())).toEqual([]);
    });

    it("takes the one logo named after a tool with a suffix", () => {
        const rows = site.parseReplaces(
            README,
            /already pay/i,
            new Set(["fly-io.svg", "render.svg"])
        );
        expect(rows[0]!.tools.map((tool) => tool.logo)).toEqual([null, "render.svg", "fly-io.svg"]);
    });

    it("reads the screenshots by section and the install lines", () => {
        expect(site.parseShowcase(README)).toEqual([
            {
                heading: "Talk",
                items: [
                    {
                        name: "Chat",
                        caption: "spaces and threads",
                        dark: "chat-dark-en-desktop.webp",
                        light: "chat-light-en-desktop.webp",
                        alt: "Chat: spaces"
                    }
                ]
            }
        ]);
        expect(site.parseInstallLines(README)).toEqual({
            unix: "curl -fsSL https://example.test/install.sh | sh",
            windows: "irm https://example.test/install.ps1 | iex"
        });
    });
});

describe("apiOperations", () => {
    it("groups operations by tag in the document's order", () => {
        const groups = site.apiOperations({
            tags: [{ name: "Account" }, { name: "Deploy" }],
            paths: {
                "/api/deploy/{id}": {
                    get: {
                        operationId: "getDeploy",
                        tags: ["Deploy"],
                        summary: "One deploy",
                        parameters: [
                            { name: "id", in: "path", required: true, schema: { type: "string" } }
                        ],
                        responses: { "200": { description: "The deploy" } }
                    },
                    post: {
                        operationId: "startDeploy",
                        tags: ["Deploy"],
                        requestBody: {
                            content: { "application/json": { schema: { type: "object" } } }
                        },
                        responses: {}
                    }
                },
                "/api/me": { get: { operationId: "me", tags: ["Account"], responses: {} } }
            }
        });
        expect(groups.map((group) => group.tag)).toEqual(["Account", "Deploy"]);
        expect(groups[1]!.operations.map((op) => op.method)).toEqual(["GET", "POST"]);
        expect(groups[1]!.operations[0]!.parameters[0]).toEqual({
            name: "id",
            in: "path",
            required: true,
            type: "string",
            description: ""
        });
        expect(groups[1]!.operations[1]!.body).toContain('"type": "object"');
    });

    it("fills message placeholders and leaves unknown ones", () => {
        expect(site.fill("Step {n} of {total}", { n: 1 })).toBe("Step 1 of {total}");
    });
});

describe("site words", () => {
    it("has the same keys in English and Spanish", async () => {
        const keys = (value: unknown, prefix = ""): string[] =>
            typeof value === "object" && value
                ? Object.entries(value).flatMap(([key, inner]) => keys(inner, `${prefix}${key}.`))
                : [prefix];
        const en = (await import("../../src/messages/en.json")).default;
        const es = (await import("../../src/messages/es.json")).default;
        expect(keys(es).sort()).toEqual(keys(en).sort());
    });
});
