import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { llmsText, REPOSITORY_MAP } from "../../src/data/llms";

const repoRoot = join(__dirname, "..", "..", "..", "..", "..");

const data = {
    repo: "FJRG2007/polaris",
    install: { unix: "curl -fsSL https://example.test/install.sh | sh", windows: null },
    docs: {
        en: [
            {
                slug: "troubleshooting",
                source: "docs/features/troubleshooting.md",
                title: "When Polaris cannot be reached",
                summary: "What to check first.",
                headings: [],
                html: "",
                text: {}
            }
        ],
        es: []
    },
    locales: {
        en: {
            apps: [{ id: "crm", name: "CRM", summary: "Contacts and deals." }],
            builtIn: [{ id: "drive", name: "Drive", description: "Files." }]
        }
    },
    api: {
        groups: [
            {
                tag: "Account",
                operations: [{ id: "getMe", tag: "Account", method: "GET", path: "/api/v1/me", summary: "Who this key acts as" }]
            }
        ]
    }
} as unknown as Parameters<typeof llmsText>[0];

describe("llms.txt", () => {
    const text = llmsText(data, "https://fjrg2007.github.io/polaris", "Self-hosted platform.");

    it("opens the way llmstxt.org reads it: a title, then the summary as a quote", () => {
        expect(text.startsWith("# Polaris\n\n> Self-hosted platform.\n")).toBe(true);
    });

    it("links every guide absolutely, with its Markdown source", () => {
        expect(text).toContain(
            "- [When Polaris cannot be reached](https://fjrg2007.github.io/polaris/en/docs/troubleshooting/): What to check first. (source: https://github.com/FJRG2007/polaris/blob/main/docs/features/troubleshooting.md)"
        );
    });

    it("lists built-in apps and marketplace apps", () => {
        expect(text).toContain("- [Drive](https://fjrg2007.github.io/polaris/en/marketplace/drive/): Files.");
        expect(text).toContain("- [CRM](https://fjrg2007.github.io/polaris/en/marketplace/crm/): Contacts and deals.");
    });

    it("names the API document and the install command", () => {
        expect(text).toContain("(https://fjrg2007.github.io/polaris/openapi.json)");
        expect(text).toContain("- Linux and macOS: `curl -fsSL https://example.test/install.sh | sh`");
        expect(text).not.toContain("Windows:");
    });

    it("links the API overview, each group and each call", () => {
        expect(text).toContain("- [API reference](https://fjrg2007.github.io/polaris/en/docs/api/)");
        expect(text).toContain("- [Account](https://fjrg2007.github.io/polaris/en/docs/api/account/): 1 call");
        expect(text).toContain(
            "  - [GET /api/v1/me](https://fjrg2007.github.io/polaris/en/docs/api/account/get-me/): Who this key acts as"
        );
    });

    it("ends with exactly one newline", () => {
        expect(text.endsWith("\n")).toBe(true);
        expect(text.endsWith("\n\n")).toBe(false);
    });

    it("maps only folders that exist", () => {
        for (const entry of REPOSITORY_MAP) expect(existsSync(join(repoRoot, entry.path)), entry.path).toBe(true);
    });
});
