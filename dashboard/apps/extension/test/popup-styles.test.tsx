// @vitest-environment jsdom

/**
 * The popup's markup against its stylesheet.
 *
 * Settings once drew its sections with classes borrowed from elsewhere: the
 * generator's `row` (a divider and its own padding) and its monospace `chip`,
 * under section headings that held a gutter their contents did not. Nothing
 * failed - the page simply came out misaligned. What is pinned here is the
 * class of that bug: every class the popup's components use is one the popup's
 * stylesheet defines, every Settings section draws its contents inside the
 * shared gutter, and form controls take the popup's font.
 */

import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../src/entrypoints/popup/settings";

// Paths, not URLs: under jsdom `URL` is the page's, which cannot name a file.
const POPUP = join(import.meta.dirname, "../src/entrypoints/popup");
const SIDEPANEL = join(import.meta.dirname, "../src/entrypoints/sidepanel");

/** The stylesheet with its comments removed. */
function css(dir: string, file: string): string {
    return readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every class name a stylesheet's selectors mention. */
function definedClasses(sheet: string): Set<string> {
    const found = new Set<string>();
    for (const match of sheet.matchAll(/([^{}]+)\{/g))
        for (const name of match[1]!.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) found.add(name[1]!);
    return found;
}

/** The expression after `className=`, a quoted string or a braced one. */
function classExpressions(source: string): string[] {
    const found: string[] = [];
    for (const match of source.matchAll(/className=/g)) {
        let at = match.index! + "className=".length;
        if (source[at] === '"') {
            found.push(source.slice(at, source.indexOf('"', at + 1) + 1));
            continue;
        }
        let depth = 0;
        const start = at;
        for (; at < source.length; at++) {
            if (source[at] === "{") depth++;
            else if (source[at] === "}" && --depth === 0) break;
        }
        found.push(source.slice(start, at + 1));
    }
    return found;
}

/** The literal class names an expression can produce; interpolations are skipped. */
function literalClasses(expression: string): string[] {
    const names: string[] = [];
    for (const literal of expression.matchAll(/"([^"]*)"|`([^`]*)`/g)) {
        const text = (literal[1] ?? literal[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
        names.push(...text.split(/\s+/).filter(Boolean));
    }
    return names;
}

/** Class names used in a folder's components that none of its stylesheets define. */
function undefinedClasses(dir: string, sheets: string[]): string[] {
    const defined = definedClasses(sheets.join("\n"));
    const missing: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".tsx"))) {
        const source = readFileSync(join(dir, file), "utf8");
        for (const expression of classExpressions(source))
            for (const name of literalClasses(expression))
                if (!defined.has(name)) missing.push(`${file}: ${name}`);
    }
    return [...new Set(missing)];
}

describe("the popup's classes", () => {
    it("are all defined in the popup's stylesheet", () => {
        expect(undefinedClasses(POPUP, [css(POPUP, "style.css")])).toEqual([]);
    });

    it("are all defined in the side panel's stylesheets", () => {
        // The side panel loads its own sheet on top of the popup's.
        const sheets = [css(SIDEPANEL, "panel.css"), css(POPUP, "style.css")];
        expect(undefinedClasses(SIDEPANEL, sheets)).toEqual([]);
    });

    it("give form controls the popup's font, not the browser's", () => {
        expect(css(POPUP, "style.css")).toMatch(
            /button,\s*input,\s*select,\s*textarea\s*\{\s*font:\s*inherit;/
        );
    });

    it("draw a choice in Settings in the popup's own type", () => {
        expect(css(POPUP, "style.css")).toMatch(
            /button\.chip\.choice\s*\{[^}]*font-family:\s*var\(--font-sans\)/
        );
    });
});

describe("the Settings sections", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("hold everything under a heading inside the shared gutter", () => {
        vi.stubGlobal("browser", {});
        const markup = renderToStaticMarkup(<Settings canPolar />);
        const page = new DOMParser().parseFromString(markup, "text/html");
        const main = page.querySelector("main.settings")!;
        const sections = [...main.children];
        expect(sections.length).toBeGreaterThanOrEqual(2);
        for (const section of sections) {
            expect(section.className).toBe("settings-section");
            const parts = [...section.children].map((child) =>
                child.tagName === "H2" ? "heading" : child.className
            );
            expect(parts).toEqual(["heading", "settings-body"]);
        }
        // Every choice is drawn as a Settings choice, not as the generator's chip.
        const chips = [...main.querySelectorAll("button.chip")];
        expect(chips.length).toBeGreaterThan(0);
        for (const chip of chips) expect(chip.classList.contains("choice")).toBe(true);
    });
});
