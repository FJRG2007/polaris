/**
 * The site's data builders over fixtures: the catalogue to marketplace entries,
 * the README to the "replaces" table and the screenshots, and the OpenAPI
 * document to the reference.
 */

import { describe, expect, it } from "vitest";
import * as site from "../../src/data/builders";

const app = (id: string, extra: Partial<site.CatalogInput> = {}): site.CatalogInput => ({
    id,
    name: id.toUpperCase(),
    category: "Tools",
    summary: `${id} summary`,
    description: `${id} description`,
    installMethod: "compose-template",
    mark: "<svg></svg>",
    markLarge: "<svg></svg>",
    tint: "#123456",
    ink: "#ffffff",
    developer: "Polaris",
    distributor: "Polaris",
    shots: { en: null, es: null },
    ...extra
});

describe("siteApps", () => {
    it("lists every catalogue app, so a new one appears with no edit to the site", () => {
        const apps = site.siteApps(
            [app("b"), app("a", { installMethod: "builtin" }), app("c", { comingSoon: true })],
            "en"
        );
        expect(apps.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
        expect(apps[0]!.builtin).toBe(true);
        expect(apps[1]!.builtin).toBe(false);
        expect(apps[2]!.comingSoon).toBe(true);
    });

    it("takes a locale's words and falls back to the catalogue's own", () => {
        const [entry] = site.siteApps([app("a", { distributor: "Docker Hub" })], "es", {
            card: {
                by: "De {developer}",
                byImage: "De {developer}, imagen de {distributor}",
                preview: "Vista de {name}"
            },
            apps: { a: { name: "Uno" } },
            categories: { Tools: "Herramientas" }
        });
        expect(entry!.name).toBe("Uno");
        expect(entry!.summary).toBe("a summary");
        expect(entry!.categoryLabel).toBe("Herramientas");
    });

    it("filters by text and category", () => {
        const apps = site.siteApps([app("chat", { category: "Messaging" }), app("notes")], "en");
        expect(
            apps.filter((entry) => site.matchesApp(entry, "cha", "")).map((entry) => entry.id)
        ).toEqual(["chat"]);
        expect(
            apps.filter((entry) => site.matchesApp(entry, "", "Tools")).map((entry) => entry.id)
        ).toEqual(["notes"]);
        expect(site.siteCategories(apps).map((entry) => entry.id)).toEqual(["Messaging", "Tools"]);
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
