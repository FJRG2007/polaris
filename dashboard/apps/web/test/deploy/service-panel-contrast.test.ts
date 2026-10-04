/**
 * The service panel is drawn the way every other side panel is - on the
 * dialog's own surface, with the application's own fields, borders and tabs -
 * and keeps two things of its own (globals.css, "The service panel's surface
 * and switches"). These are the pairs that decide whether that works, measured
 * with the WCAG 2.x contrast formula in every theme against the global tokens.
 *
 *   - Nothing about a field is overridden: its fill, its edge and its hover are
 *     the application's, so a field here looks like a field anywhere else.
 *   - A card is the dialog's surface with its hairline, never a darker tone that
 *     reads as a hole in it, and the panel's body is not the page ground.
 *   - An unchecked switch is a track with no other boundary, so it holds the
 *     3:1 of WCAG 1.4.11 against the surface and the page, and is never weaker
 *     than the switch everywhere else.
 *   - A field still differs from the surface by its fill, and the focus ring
 *     and the text in a field stay readable.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(
    new URL("../../../../packages/ui/src/styles/tokens.css", import.meta.url),
    "utf8"
);
const GLOBALS = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
const SERVICE_DETAIL = readFileSync(
    new URL("../../src/app/(app)/apps/deploy/service-detail.tsx", import.meta.url),
    "utf8"
);

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
        // Inside the panel a card is the dialog's own surface.
        const tone = (name: string): Hsl => {
            const key = name === "card" ? "elevated" : name;
            const value = panel[key] ?? base[key];
            if (!value) throw new Error(`${theme} has no --${key}`);
            return value;
        };

        it(`${theme}: overrides nothing about a field or a border`, () => {
            for (const name of ["field", "field-edge", "border", "border-strong"]) {
                expect(panel[name]).toBeUndefined();
            }
        });

        it(`${theme}: a field is told from the surface by its fill`, () => {
            expect(contrast(tone("field"), tone("card"))).toBeGreaterThanOrEqual(1.05);
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

    it("draws a card as the dialog's surface, not as a darker tone under it", () => {
        const rules = GLOBALS.slice(GLOBALS.indexOf("[data-service-panel] {"));
        expect(rules.slice(0, rules.indexOf("}"))).toContain("--card: var(--elevated);");
    });

    it("keeps its body on the dialog's surface rather than the page ground", () => {
        const body = SERVICE_DETAIL.slice(SERVICE_DETAIL.indexOf("flex-1 overflow-y-auto"));
        expect(body.slice(0, body.indexOf('"'))).not.toContain("bg-background");
        expect(GLOBALS).not.toContain("[data-service-panel] :is(input, textarea, button).bg-field");
    });

    it("follows the machine with the light theme's own values", () => {
        const media = GLOBALS.slice(GLOBALS.indexOf(":root.system [data-service-panel] {"));
        expect(block(media, ":root.system [data-service-panel]")).toEqual(THEMES.light!.panel);
    });
});
