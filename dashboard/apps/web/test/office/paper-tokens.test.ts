/**
 * A document's page has to read as a sheet against the desk around it, in every
 * theme. Measured with the WCAG 2.x contrast formula against the tokens
 * themselves, so a later change to a theme cannot quietly put the page back to
 * a white rectangle on a near-white ground.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(
    new URL("../../../../packages/ui/src/styles/tokens.css", import.meta.url),
    "utf8"
);
const DOC_EDITOR = readFileSync(
    new URL("../../src/app/(app)/office/d/[id]/doc-editor.tsx", import.meta.url),
    "utf8"
);

type Hsl = [number, number, number];

function block(selector: string): Record<string, Hsl> {
    const at = TOKENS.indexOf(`${selector} {`);
    if (at < 0) throw new Error(`no ${selector} block`);
    const body = TOKENS.slice(at, TOKENS.indexOf("}", at));
    const out: Record<string, Hsl> = {};
    for (const match of body.matchAll(/--([a-z-]+):\s*([\d.]+) ([\d.]+)% ([\d.]+)%;/g)) {
        out[match[1]!] = [Number(match[2]), Number(match[3]), Number(match[4])];
    }
    return out;
}

function luminance([hue, saturation, lightness]: Hsl): number {
    const s = saturation / 100;
    const l = lightness / 100;
    const a = s * Math.min(l, 1 - l);
    const channel = (n: number) => {
        const k = (n + hue / 30) % 12;
        const value = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4);
}

function contrast(a: Hsl, b: Hsl): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (light + 0.05) / (dark + 0.05);
}

const THEMES: Record<string, string> = {
    dark: ":root",
    light: ":root.light",
    system: ":root.system",
    midnight: ":root.midnight",
    graphite: ":root.graphite"
};

describe("a document's page against its desk", () => {
    for (const [theme, selector] of Object.entries(THEMES)) {
        it(`stands out in the ${theme} theme`, () => {
            const own = block(selector);
            for (const token of ["canvas", "paper", "paper-edge"]) expect(own[token]).toBeDefined();
            const { canvas, paper } = own as Record<string, Hsl>;
            // A clearer step than any two neighbouring depth tiers.
            expect(contrast(paper!, canvas!)).toBeGreaterThanOrEqual(1.15);
            expect(contrast(own["paper-edge"]!, paper!)).toBeGreaterThanOrEqual(1.3);
            // The page is lighter than its desk - a sheet, never a hole.
            expect(luminance(paper!)).toBeGreaterThan(luminance(canvas!));
        });
    }

    it("is what the document editor draws", () => {
        expect(DOC_EDITOR).toContain("bg-canvas");
        expect(DOC_EDITOR).toMatch(/border-paper-edge[^"]*bg-paper/);
    });
});
