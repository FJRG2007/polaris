/**
 * The deploy side panels (service, database, volume) are drawn as a page - on
 * the page ground, with the application's own cards, fields, borders and tabs -
 * and keep one thing of their own (globals.css, "The deploy side panels' ground
 * and switches"). These are the pairs that decide whether that works, measured
 * with the WCAG 2.x contrast formula in every theme against the global tokens.
 *
 *   - Nothing about a field or a card is overridden, so either looks here the
 *     way it does on any other page.
 *   - Every panel, header included, sits on the page ground, not on the
 *     dialog's raised surface.
 *   - A field keeps a fill of its own on a card and on the page ground.
 *   - An unchecked switch is a track with no other boundary, so it holds the
 *     3:1 of WCAG 1.4.11 against a card and the page, and is never weaker
 *     than the switch everywhere else.
 *   - The focus ring and the text in a field stay readable.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(
    new URL("../../../../packages/ui/src/styles/tokens.css", import.meta.url),
    "utf8"
);
const GLOBALS = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
const PANELS = ["service-detail.tsx", "database-panel.tsx", "volume-detail.tsx"].map((file) => ({
    file,
    source: readFileSync(
        new URL(`../../src/app/(app)/apps/deploy/${file}`, import.meta.url),
        "utf8"
    )
}));

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

describe("service panel", () => {
    for (const [theme, { base, panel }] of Object.entries(THEMES)) {
        const tone = (name: string): Hsl => {
            const value = panel[name] ?? base[name];
            if (!value) throw new Error(`${theme} has no --${name}`);
            return value;
        };

        it(`${theme}: overrides nothing about a field, a card or a border`, () => {
            for (const name of ["field", "field-edge", "border", "border-strong", "card", "card-hover"]) {
                expect(panel[name]).toBeUndefined();
            }
        });

        // The same inset field as on every other page: a tone of its own on a
        // card and on the ground, with the field's border as its edge.
        it(`${theme}: a field is told from a card and the page by its fill`, () => {
            expect(contrast(tone("field"), tone("card"))).toBeGreaterThanOrEqual(1.02);
            expect(contrast(tone("field"), tone("background"))).toBeGreaterThanOrEqual(1.02);
        });

        it(`${theme}: an unchecked switch holds 3:1 on the surface and the page`, () => {
            expect(contrast(tone("switch-off"), tone("card"))).toBeGreaterThanOrEqual(3);
            expect(contrast(tone("switch-off"), tone("background"))).toBeGreaterThanOrEqual(3);
            expect(contrast(tone("switch-off"), tone("card"))).toBeGreaterThan(
                contrast(base.muted!, tone("card"))
            );
        });

        it(`${theme}: focus ring and text stay readable on a field`, () => {
            expect(contrast(tone("ring"), tone("field"))).toBeGreaterThanOrEqual(3);
            expect(contrast(tone("ring"), tone("card"))).toBeGreaterThanOrEqual(3);
            expect(contrast(tone("foreground"), tone("field"))).toBeGreaterThanOrEqual(4.5);
            expect(contrast(tone("muted-foreground"), tone("field"))).toBeGreaterThanOrEqual(4.5);
        });
    }

    for (const { file, source } of PANELS) {
        it(`${file}: the whole panel sits on the page ground and gets the switch tuning`, () => {
            const panel = source.slice(source.indexOf("<DialogContent"));
            const tag = panel.slice(0, panel.indexOf(">\n"));
            expect(tag).toContain('data-service-panel=""');
            expect(tag).toMatch(/"[^"]*\bbg-background\b[^"]*"/);
            expect(tag).not.toMatch(/\bbg-(elevated|surface)\b/);
        });
    }

    it("never overrides a field's own fill", () => {
        expect(GLOBALS).not.toContain("[data-service-panel] :is(input, textarea, button).bg-field");
    });

    it("follows the machine with the light theme's own values", () => {
        const media = GLOBALS.slice(GLOBALS.indexOf(":root.system [data-service-panel] {"));
        expect(block(media, ":root.system [data-service-panel]")).toEqual(THEMES.light!.panel);
    });
});
