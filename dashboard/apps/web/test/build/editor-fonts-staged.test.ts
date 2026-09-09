import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { pointAtAssets } from "../../../../scripts/scope-editor-styles.mjs";
import {
    FACE,
    NOTICE,
    base,
    katexSheet,
    sources,
    stageFonts
} from "../../scripts/copy-office-fonts.mjs";

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
            // serve it from here. A root-absolute path and a `#` fragment are
            // already answered by this origin and this document; flattened to a
            // file name they would ask the font directory for an image, or for a
            // filter that is not a file at all.
            for (const url of [
                "url('data:image/svg+xml,%3Csvg%3E')",
                "url(https://example.invalid/a.png)",
                "url(//example.invalid/a.png)",
                "url(/images/logo.svg)",
                "url(#blur)"
            ]) {
                expect(pointAtAssets(`a{background:${url}}`, "/f")).toContain(url);
            }
        });

        it("survives a sheet with no url at all", () => {
            expect(pointAtAssets("a{color:red}", "/f")).toBe("a{color:red}");
        });
    });

    describe("what the sheets ask for is what the build stages", () => {
        /** What the staging step copies, asked of the staging step rather than
         *  restated here. A second list would go on agreeing with the sheets
         *  while the build agreed with neither, which is the divergence this
         *  file exists to catch. */
        const staged = new Set(
            sources.flatMap(({ dir }) => readdirSync(dir)).filter((name) => FACE.test(name))
        );

        /** Every file name a stylesheet asks this origin for. */
        const asked = (sheet: string): string[] =>
            [
                ...pointAtAssets(readFileSync(sheet, "utf8"), base).matchAll(
                    new RegExp(`url\\('${base}/([^']+)'\\)`, "g")
                )
            ].map((match) => match[1]);

        it.each([
            ["the Word editor", "genoffice-docs"],
            ["the Markdown editor", "genoffice-markdown"]
        ])("%s is built pointing at the directory this step fills", (_name, pkg) => {
            // The other half of the agreement, and the one nothing else reads:
            // the base in the build command has to be the directory the staging
            // step creates under `public/`.
            const manifest = JSON.parse(
                readFileSync(join(dashboard, "packages", pkg, "package.json"), "utf8")
            ) as { scripts: Record<string, string> };
            expect(manifest.scripts.build).toContain(`--assets=${base}`);
        });

        it("builds the formula sheet from the KaTeX whose faces this step stages", () => {
            // Resolved, not reached for through `node_modules`: the root holds a
            // different version of KaTeX, put there by something else, and a
            // stylesheet from one copy with the faces of another is a formula
            // drawn in boxes.
            const manifest = JSON.parse(
                readFileSync(
                    join(dashboard, "packages", "genoffice-markdown", "package.json"),
                    "utf8"
                )
            ) as { scripts: Record<string, string> };
            expect(manifest.scripts.build).toContain("pkg:katex/dist/katex.min.css");
        });

        const sheets: [string, string][] = [
            ["the Word editor", join(dashboard, "packages", "genoffice-docs", "src", "renderer", "fonts", "fonts.css")],
            ["formulas", katexSheet]
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

    describe("what the step actually writes", () => {
        /** Stage into a directory of its own, so the assertions are about what
         *  this run wrote rather than about whatever a previous build left in
         *  `public/`. */
        const staging = (): [string, () => void] => {
            const into = mkdtempSync(join(tmpdir(), "office-fonts-"));
            return [into, () => rmSync(into, { recursive: true, force: true })];
        };

        it("puts the licence in the directory the fonts are served from", () => {
            // Carlito, Liberation and the Noto faces are OFL 1.1, which requires
            // the licence text to accompany every redistributed copy, and this
            // directory is where they are redistributed - the runtime image
            // carries `public/` and nothing else, so a text left in the checkout
            // ships nowhere near the fonts it covers. The README travels with it
            // because it is what records the exception: Caladea is Apache-2.0,
            // and the Carlito build here is a renamed derivative under §2.
            const [into, clean] = staging();
            try {
                const { faces, notices } = stageFonts(into);
                const written = readdirSync(into);
                expect(faces).toBe(written.filter((name) => FACE.test(name)).length);
                expect(notices).toBe(written.filter((name) => !FACE.test(name)).length);
                expect(written).toContain("genoffice-docs-LICENSE-OFL.txt");
                // Both packages call theirs README.md, which is why a notice is
                // staged under the name of the package it came from: flat, one
                // would answer for the other.
                expect(written).toContain("genoffice-docs-README.md");
                expect(written).toContain("genoffice-ui-README.md");
                expect(readFileSync(join(into, "genoffice-docs-README.md"), "utf8")).toContain(
                    "Apache"
                );
            } finally {
                clean();
            }
        });

        it("refuses two sources that stage the same file name", () => {
            // The sources are disjoint today. Flattened into one directory they
            // need not stay that way, and the second copy replaces the first
            // without a word: a document drawn in a real face that is the wrong
            // one, off a green build.
            const [into, clean] = staging();
            sources.push({ label: "duplicate", dir: sources[1].dir });
            try {
                expect(() => stageFonts(into)).toThrow(/stage a file named Carlito-/);
            } finally {
                sources.pop();
                clean();
            }
        });

        it("counts a notice as a notice rather than as a face", () => {
            // The regex decides which pile a file lands in, and a face whose
            // name happens to start with one of those words is still a face.
            expect(NOTICE.test("LICENSE-OFL.txt")).toBe(true);
            expect(NOTICE.test("README.md")).toBe(true);
            expect(FACE.test("LiberationSans-Regular.ttf")).toBe(true);
            expect(NOTICE.test("NotoSansArabic-Regular-subset.woff2")).toBe(false);
        });
    });
});
