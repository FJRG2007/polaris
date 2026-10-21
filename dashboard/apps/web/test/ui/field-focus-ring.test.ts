/**
 * A field you type in shows focus on a mouse click too. Its ring is drawn on
 * its own edge, so it never reads as a second box around the field and a
 * toolbar that clips its overflow cannot cut it in half. Everything else keeps
 * the ring outside, where it does not change the layout of its row.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(
    new URL("../../../../packages/ui/src/styles/tokens.css", import.meta.url),
    "utf8"
);

/** Where the field selector closes, however a formatter indented it. */
const FIELDS = TOKENS.search(/textarea\s*\):focus-visible/);

function ruleAfter(marker: string | number): string {
    const start = typeof marker === "number" ? marker : TOKENS.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const open = TOKENS.indexOf("{", start);
    return TOKENS.slice(start, TOKENS.indexOf("}", open) + 1);
}

describe("the focus ring", () => {
    it("stays outside buttons, links and other controls", () => {
        const rule = ruleAfter(':where(a, button, [role="button"]');
        expect(rule).toContain("outline-offset: 2px;");
    });

    it("sits on the edge of a field, after the general rule so it wins", () => {
        const general = TOKENS.indexOf(':where(a, button, [role="button"]');
        expect(FIELDS).toBeGreaterThan(general);
        const rule = ruleAfter(FIELDS);
        expect(rule).toContain("outline-offset: -1px;");
    });

    it("leaves checkboxes and radios with the outside ring", () => {
        const selector = TOKENS.slice(TOKENS.indexOf("input:not("), FIELDS);
        expect(selector).toContain('[type="checkbox"]');
        expect(selector).toContain('[type="radio"]');
    });
});
