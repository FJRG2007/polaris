import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { pointAtAssets } from "../../../../scripts/scope-editor-styles.mjs";

/**
 * The embedded editors' fonts, and the two halves that have to agree.
 *
 * The faces are not decoration. A .docx names Calibri and Cambria, almost no
 * machine has either, and what these editors ship are the metric-compatible
 * substitutes - Carlito and Caladea - which occupy exactly the same widths. Drawn
 * in whatever the browser falls back to, every line of a document ends somewhere
 * else. The editors shipped without them once, which is a document that looks
 * wrong rather than a document in a different font, and it is not the kind of
 * thing a screenshot of the toolbar reveals.
 *
 * Two halves: the stylesheet is rewritten to ask this origin for a flat file
 * name, and a build step stages the files under that name. Neither is any use
 * alone, and the failure when they disagree is silent - the browser asks for a
 * font, gets a 404, and draws the fallback without a word.
 */
describe("the editors' fonts", () => {
    const require = createRequire(import.meta.url);
    const dashboard = join(__dirname, "..", "..", "..", "..");

    describe("pointing a stylesheet at the staged files", () => {
        it("keeps the file name and drops the path the editor's bundler resolved", () => {
            // Both shapes appear in one sheet: an alias into the shared package,
            // and a file beside the stylesheet.
            expect(
                pointAtAssets("@font-face{src:url('@genoffice/ui/fonts/Carlito.ttf')}", "/f")
            ).toContain("url('/f/Carlito.ttf')");
            expect(pointAtAssets("@font-face{src:url(./Caladea.ttf)}", "/f")).toContain(
                "url('/f/Caladea.ttf')"
            );
            expect(pointAtAssets('@font-face{src:url("fonts/KaTeX.woff2")}', "/f")).toContain(
                "url('/f/KaTeX.woff2')"
            );
        });

        it("leaves alone what already resolves on its own", () => {
            // A data URI IS the file - rewriting it points at nothing. A remote
            // one is somebody else's server, and this must not quietly decide to
            // serve it from here.
            for (const url of [
                "url('data:image/svg+xml,%3Csvg%3E')",
                "url(https://example.invalid/a.png)",
                "url(//example.invalid/a.png)"
            ]) {
                expect(pointAtAssets(`a{background:${url}}`, "/f")).toContain(url);
            }
        });

        it("survives a sheet with no url at all", () => {
            expect(pointAtAssets("a{color:red}", "/f")).toBe("a{color:red}");
        });
    });

    describe("what the sheets ask for is what the build stages", () => {
        /** The directories `copy-office-fonts.mjs` copies from, in its order. */
        const sources = [
            join(dashboard, "packages", "genoffice-docs", "src", "renderer", "fonts"),
            join(dashboard, "packages", "genoffice-ui", "src", "fonts"),
            join(require.resolve("katex/dist/katex.min.css"), "..", "fonts")
        ];

        const staged = new Set(
            sources
                .filter((source) => existsSync(source))
                .flatMap((source) => readdirSync(source))
                .filter((name) => /\.(ttf|otf|woff2?|eot)$/i.test(name))
        );

        /** Every file name a stylesheet asks this origin for. */
        const asked = (sheet: string): string[] =>
            [...pointAtAssets(readFileSync(sheet, "utf8"), "/office-fonts").matchAll(
                /url\('\/office-fonts\/([^']+)'\)/g
            )].map((match) => match[1]);

        const sheets: [string, string][] = [
            ["the Word editor", join(dashboard, "packages", "genoffice-docs", "src", "renderer", "fonts", "fonts.css")],
            ["formulas", require.resolve("katex/dist/katex.min.css")]
        ];

        it.each(sheets)("%s asks for something", (_name, sheet) => {
            // A sheet that asks for nothing would pass the check below by saying
            // nothing, which is how this file could stop testing anything.
            expect(asked(sheet).length).toBeGreaterThan(0);
        });

        it.each(sheets)("every face %s names is staged", (_name, sheet) => {
            expect([...new Set(asked(sheet))].filter((file) => !staged.has(file))).toEqual([]);
        });

        it("stages the substitute faces a .docx actually names", () => {
            // The whole reason this exists. Calibri and Cambria are not
            // redistributable; these two are, and they were built to occupy the
            // same widths.
            for (const face of ["Carlito-Regular.ttf", "Caladea-Regular.ttf"]) {
                expect(staged.has(face), face).toBe(true);
            }
        });
    });
});
