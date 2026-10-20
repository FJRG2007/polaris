/**
 * A box that scrolls on its own is positioned, so the `sr-only` text inside it
 * belongs to it and not to the page.
 *
 * The bug this exists for: the query log's hidden row text made a 1,048px
 * screen 13,174px tall. The rule that holds it is unlayered and has zero
 * specificity, so it only wins because it comes after `@tailwind utilities`;
 * moved above it, or into a layer, it stops applying with nothing to say so.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const GLOBALS = fileURLToPath(new URL("../../src/app/globals.css", import.meta.url));

const SCROLL_CLASSES = [
    "overflow-auto",
    "overflow-scroll",
    "overflow-y-auto",
    "overflow-y-scroll",
    "overflow-x-auto",
    "overflow-x-scroll"
];

describe("scroll boxes hold what is positioned inside them", async () => {
    const css = await readFile(GLOBALS, "utf8");
    const rule = /:where\(([^)]*)\)\s*\{\s*position:\s*relative;\s*\}/.exec(css);

    it("gives every scrolling class position: relative", () => {
        expect(rule).not.toBeNull();
        for (const name of SCROLL_CLASSES) expect(rule![1]).toContain(`[class*="${name}"]`);
    });

    it("comes after the utilities and outside any layer", () => {
        const at = rule!.index;
        expect(at).toBeGreaterThan(css.indexOf("@tailwind utilities"));
        const before = css.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, "");
        const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
        expect(depth).toBe(0);
    });
});
