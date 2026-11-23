/**
 * The docked picker's look compiles to selectors that match it.
 *
 * Its first spelling, `data-[docked=true]:[&_ul]:w-full`, compiled to
 * `.x ul[data-docked="true"]` - the attribute on the list rather than on the
 * docked element - so on a phone the list kept its popover width and its rows
 * their mouse size. This compiles the real class string with Tailwind and reads
 * the selectors back.
 */

import postcss from "postcss";
import tailwind from "tailwindcss";
import { describe, expect, it } from "vitest";
import { DOCKED_CLASS } from "@/components/rich-text/suggestion";

async function selectorsOf(classes: string): Promise<string[]> {
    const result = await postcss([
        tailwind({ content: [{ raw: classes, extension: "html" }], corePlugins: { preflight: false } })
    ]).process("@tailwind utilities;", { from: undefined });
    const selectors: string[] = [];
    result.root.walkRules((rule) => selectors.push(rule.selector));
    return selectors;
}

describe("DOCKED_CLASS", () => {
    it("puts the attribute on the docked element, not on what is inside it", async () => {
        const selectors = await selectorsOf(DOCKED_CLASS);
        expect(selectors.length).toBe(DOCKED_CLASS.split(/\s+/).length);
        for (const selector of selectors) expect(selector).toMatch(/\[data-docked=true\] /);
        expect(selectors.some((selector) => selector.endsWith("[data-docked=true] ul"))).toBe(true);
        expect(selectors.some((selector) => selector.endsWith("[data-docked=true] li>button"))).toBe(true);
    });
});
