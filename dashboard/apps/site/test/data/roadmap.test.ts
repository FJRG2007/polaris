import { marked, type Tokens } from "marked";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { docSlug, headingId, rewriteDocLinks, ROADMAP, splitDoc } from "../../src/data/docs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

/** The headings the site's renderer lists in a page's outline (levels 2 and 3). */
const outline = (body: string) =>
    marked
        .lexer(body)
        .filter((token): token is Tokens.Heading => token.type === "heading")
        .filter((token) => token.depth <= 3)
        .map((token) => headingId(token.text));

describe("the roadmap page", () => {
    it("is found in both languages and named after its file", () => {
        for (const file of [ROADMAP.en, ROADMAP.es]) {
            expect(existsSync(join(root, file))).toBe(true);
            expect(docSlug(file.split("/").pop()!)).toBe(ROADMAP.slug);
        }
    });

    it("parses to a title and the same outline in English and Spanish", () => {
        const en = splitDoc(read(ROADMAP.en));
        const es = splitDoc(read(ROADMAP.es));
        expect(en.title).toBe("Roadmap");
        expect(es.title).toBe("Hoja de ruta");
        // The language line under the title is the site's to draw, not the page's.
        expect(en.body).not.toMatch(/README/);
        expect(es.body).not.toMatch(/README\.es\.md\)/);
        const enHeadings = outline(en.body);
        const esHeadings = outline(es.body);
        expect(enHeadings).toContain("platform-direction");
        expect(enHeadings).toContain("scale-and-the-app-platform");
        expect(enHeadings).toContain("per-area-roadmaps");
        expect(enHeadings).toContain("how-this-roadmap-is-kept");
        expect(esHeadings).toContain("direccion-de-la-plataforma");
        expect(esHeadings).toContain("hojas-de-ruta-por-area");
        expect(esHeadings.length).toBe(enHeadings.length);
    });

    it("links every per-area roadmap, and each link opens the file on GitHub", () => {
        const sources = [
            "docs/agents-roadmap.md",
            "docs/chat-roadmap.md",
            "docs/crm-roadmap.md",
            "docs/deploy-roadmap.md",
            "docs/drive-roadmap.md",
            "docs/mail-roadmap.md",
            "docs/office-roadmap.md",
            "docs/telemetry-roadmap.md",
            "docs/watch-roadmap.md",
            "dashboard/ROADMAP.md"
        ];
        for (const file of [ROADMAP.en, ROADMAP.es]) {
            const html = marked.parse(splitDoc(read(file)).body, { async: false }) as string;
            const { html: linked } = rewriteDocLinks(html, {
                slugs: new Set([ROADMAP.slug]),
                repo: "owner/polaris",
                dir: "docs"
            });
            for (const source of sources) {
                expect(existsSync(join(root, source))).toBe(true);
                expect(linked).toContain(
                    `href="https://github.com/owner/polaris/blob/main/${source}"`
                );
            }
            expect(linked).not.toMatch(/href="(?!https?:|#)[^"]*\.md/);
        }
    });
});
