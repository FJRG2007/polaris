/**
 * The site's data builders over fixtures: the catalogue to marketplace entries,
 * the README to the "replaces" table and the screenshots, releases to downloads
 * (with the fallback when there is no release or no network), and the OpenAPI
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

describe("downloadEntries", () => {
    const releases: site.ReleaseInput[] = [
        {
            tag_name: "extension-v0.1.0",
            html_url: "https://gh.test/e1",
            published_at: "2026-01-01T00:00:00Z",
            assets: []
        },
        {
            tag_name: "extension-v0.2.0",
            html_url: "https://gh.test/e2",
            published_at: "2026-02-01T00:00:00Z",
            assets: [
                {
                    name: "polaris-0.2.0-chrome.zip",
                    browser_download_url: "https://gh.test/c.zip",
                    size: 10
                },
                { name: 3 }
            ]
        },
        { tag_name: "streamdeck-v9.0.0", html_url: "https://gh.test/s", draft: true },
        { tag_name: "cli-v1.0.0", html_url: "https://gh.test/c", prerelease: true }
    ];

    it("takes the newest published release of each product", () => {
        const [extension] = site.downloadEntries(releases, "o/r");
        expect(extension).toEqual({
            product: "extension",
            released: true,
            version: "0.2.0",
            url: "https://gh.test/e2",
            publishedAt: "2026-02-01T00:00:00Z",
            files: [{ name: "polaris-0.2.0-chrome.zip", url: "https://gh.test/c.zip", size: 10 }]
        });
    });

    it("falls back to the release page for drafts, prereleases, missing products and no network", () => {
        const entries = site.downloadEntries(releases, "o/r");
        expect(entries.find((entry) => entry.product === "streamdeck")).toEqual({
            product: "streamdeck",
            released: false,
            url: "https://github.com/o/r/releases?q=streamdeck"
        });
        expect(entries.find((entry) => entry.product === "cli")?.released).toBe(false);
        expect(site.downloadEntries([], "o/r").every((entry) => !entry.released)).toBe(true);
    });

    it("opens the install guide only for files installed by hand", () => {
        expect(site.guideItemFor("extension", "polaris-0.2.0-chrome.zip")).toBe(
            "extension-chromium"
        );
        expect(site.guideItemFor("extension", "polaris-0.2.0-firefox.zip")).toBe(
            "extension-firefox"
        );
        expect(site.guideItemFor("extension", "polaris-0.2.0-sources.zip")).toBeNull();
        expect(site.guideItemFor("streamdeck", "polaris.streamDeckPlugin")).toBe("streamdeck");
        expect(site.guideItemFor("companion", "polaris.tgz")).toBe("companion");
        expect(site.guideItemFor("desktop", "Polaris-0.2.0-arm64.dmg")).toBe("desktop");
        expect(site.guideItemFor("cli", "plr-linux-x64")).toBeNull();
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

describe("release files", () => {
    it("offers what is installed by hand, not the scripts the install lines fetch", () => {
        expect(site.offeredFile("streamdeck", "io.github.fjrg2007.polaris.streamDeckPlugin")).toBe(true);
        expect(site.offeredFile("extension", "polaris-extension-chrome.zip")).toBe(true);
        expect(site.offeredFile("streamdeck", "install.ps1")).toBe(false);
        expect(site.offeredFile("extension", "install.sh")).toBe(false);
        expect(site.offeredFile("extension", "polaris-extension-sources.zip")).toBe(false);
    });

    it("hides a sources archive only for the extension", () => {
        expect(site.offeredFile("desktop", "polaris-sources.zip")).toBe(true);
        expect(site.offeredFile("extension", "polaris-extension-sources-notes.txt")).toBe(true);
    });

    it("marks a file with a type short enough for its square", () => {
        expect(site.fileMark("io.github.fjrg2007.polaris.streamDeckPlugin")).toBe("SD");
        expect(site.fileMark("polaris-0.1.3.tgz")).toBe("tgz");
        expect(site.fileMark("Polaris.AppImage")).toBe("App");
    });
});

