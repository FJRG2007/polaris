import { describe, expect, it } from "vitest";
import { scopeCss } from "../../../../scripts/scope-editor-styles.mjs";

/**
 * A vendored editor's stylesheet, fenced inside the editor.
 *
 * The GenOffice editors were written to be a whole window: their CSS styles
 * `*`, `html`, `body`, `button` and `:root` directly, because in Electron that
 * page is the application. In Polaris each is a panel inside a screen, and a
 * stylesheet like that reaches everything around it - the surrounding buttons,
 * the page's background, every custom property the design system defines.
 *
 * What the fence has to get right is the handful of selectors that mean "the
 * page": they become the panel rather than something inside it, or the editor's
 * own custom properties land on an element that does not exist and the whole
 * sheet resolves to nothing.
 */
describe("fencing an editor's stylesheet", () => {
    const scoped = (css: string): string => scopeCss(css, "editor");

    it("turns the page's own selectors into the panel", () => {
        // Where the custom properties live. If these became descendants, every
        // `var(--accent)` in the sheet would resolve to nothing.
        for (const page of [":root", "html", "body", "#root", ".app"]) {
            expect(scoped(`${page} { --accent: red; }`), page).toContain(
                ".editor { --accent: red; }"
            );
        }
    });

    it("puts everything else inside the panel", () => {
        expect(scoped(".ribbon { color: red; }")).toContain(".editor .ribbon");
        expect(scoped("button { color: red; }")).toContain(".editor button");
        expect(scoped("* { box-sizing: border-box; }")).toContain(".editor *");
    });

    it("leaves nothing that can reach outside it", () => {
        const css = scoped("* { margin: 0 } body { background: #fff } .x, .y { color: red }");
        for (const line of css.split("\n")) {
            if (!line.includes("{")) continue;
            for (const selector of line.slice(0, line.indexOf("{")).split(",")) {
                expect(selector.trim(), line).toMatch(/^\.editor(\b|$)/);
            }
        }
    });

    it("goes inside a media query rather than around it", () => {
        const css = scoped("@media (min-width: 40em) { body { color: red } }");
        expect(css).toContain(".editor {");
        expect(css).toContain("@media (min-width: 40em)");
    });

    it("leaves a keyframe alone, because its steps are not selectors", () => {
        const css = scoped("@keyframes spin { from { opacity: 0 } to { opacity: 1 } }");
        expect(css).toContain("from {");
        expect(css).not.toContain(".editor from");
    });

    it("leaves a font face alone, because it has no selector at all", () => {
        const css = scoped("@font-face { font-family: Carlito; src: url(a.ttf); }");
        expect(css).toContain("@font-face");
        expect(css).not.toContain(".editor @font-face");
    });
});
