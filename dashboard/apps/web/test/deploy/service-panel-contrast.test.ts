/**
 * The service panel draws its fields, switches and section edges a step clearer
 * than the rest of the application (globals.css, "The service panel's
 * controls"). These are the pairs that decide whether that works, measured with
 * the WCAG 2.x contrast formula in every theme against the global tokens the
 * panel sits on.
 *
 * What is asserted is what identifies a control, not a raw outline:
 *
 *   - A field differs from the card it sits on by its fill (1.05:1, enough to
 *     read as a well in every theme) and by an edge of its own (1.5:1 against
 *     the card and the fill, the level Primer and Radix give a field border).
 *   - Section hairlines stay below a field's edge, so cards are separated
 *     without reading as boxes.
 *   - An unchecked switch is a track with no other boundary, so it holds the
 *     3:1 of WCAG 1.4.11 against the card and the page.
 *   - The focus ring holds 3:1 on a field and a card; text in a field 4.5:1.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(
    new URL("../../../../packages/ui/src/styles/tokens.css", import.meta.url),
    "utf8"
);
const GLOBALS = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");

type Hsl = [number, number, number];

function block(css: string, selector: string): Record<string, Hsl> {
    const at = css.indexOf(`${selector} {`);
    if (at < 0) throw new Error(`no ${selector} block`);
    const body = css.slice(at, css.indexOf("}", at));
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

const DARK = block(TOKENS, ":root");
const THEMES: Record<string, { base: Record<string, Hsl>; panel: Record<string, Hsl> }> = {
    dark: { base: DARK, panel: block(GLOBALS, "[data-service-panel]") },
    light: {
        base: { ...DARK, ...block(TOKENS, ":root.light") },
        panel: block(GLOBALS, ":root.light [data-service-panel]")
    },
    midnight: {
        base: { ...DARK, ...block(TOKENS, ":root.midnight") },
        panel: block(GLOBALS, ":root.midnight [data-service-panel]")
    },
    graphite: {
        base: { ...DARK, ...block(TOKENS, ":root.graphite") },
        panel: block(GLOBALS, ":root.graphite [data-service-panel]")
    }
};

describe("service panel controls", () => {
    for (const [theme, { base, panel }] of Object.entries(THEMES)) {
        const tone = (name: string): Hsl => {
            const value = panel[name] ?? base[name];
            if (!value) throw new Error(`${theme} has no --${name}`);
            return value;
        };

        it(`${theme}: a field is told from its card by fill and by edge`, () => {
            expect(contrast(tone("field"), tone("card"))).toBeGreaterThanOrEqual(1.05);
            expect(contrast(tone("field-edge"), tone("card"))).toBeGreaterThanOrEqual(1.5);
            expect(contrast(tone("field-edge"), tone("field"))).toBeGreaterThanOrEqual(1.5);
            expect(contrast(tone("field-edge"), tone("background"))).toBeGreaterThanOrEqual(1.5);
        });

        it(`${theme}: hover and focus make the edge clearer`, () => {
            expect(contrast(tone("border-strong"), tone("field"))).toBeGreaterThan(
                contrast(tone("field-edge"), tone("field"))
            );
        });

        it(`${theme}: section hairlines are quieter than a field's edge`, () => {
            expect(contrast(tone("border"), tone("card"))).toBeLessThan(
                contrast(tone("field-edge"), tone("card"))
            );
            expect(contrast(tone("border"), tone("background"))).toBeGreaterThanOrEqual(1.25);
        });

        it(`${theme}: an unchecked switch holds 3:1 on the card and the page`, () => {
            expect(contrast(tone("switch-off"), tone("card"))).toBeGreaterThanOrEqual(3);
            expect(contrast(tone("switch-off"), tone("background"))).toBeGreaterThanOrEqual(3);
        });

        it(`${theme}: focus ring and text stay readable on a field`, () => {
            expect(contrast(tone("ring"), tone("field"))).toBeGreaterThanOrEqual(3);
            expect(contrast(tone("ring"), tone("card"))).toBeGreaterThanOrEqual(3);
            expect(contrast(tone("foreground"), tone("field"))).toBeGreaterThanOrEqual(4.5);
            expect(contrast(tone("muted-foreground"), tone("field"))).toBeGreaterThanOrEqual(4.5);
        });
    }

    it("follows the machine with the light theme's own values", () => {
        const media = GLOBALS.slice(GLOBALS.indexOf(":root.system [data-service-panel] {"));
        expect(block(media, ":root.system [data-service-panel]")).toEqual(THEMES.light!.panel);
    });
});
