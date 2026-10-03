/**
 * The token pairs that decide whether a control can be seen, measured with the
 * WCAG 2.x contrast formula in every theme. A field, a select, a checkbox or an
 * unchecked switch is drawn with `--control-edge`, and WCAG 1.4.11 asks 3:1 for
 * the boundary that identifies a control against what it sits on; the focus ring
 * is held to the same. Section hairlines (`--border`) are not controls, but they
 * are what tells one card from the next, so they keep a floor of their own.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(path.join(__dirname, "../src/styles/tokens.css"), "utf8");

type Hsl = [number, number, number];

function block(selector: string): Record<string, Hsl> {
    const at = css.indexOf(`${selector} {`);
    if (at < 0) throw new Error(`no ${selector} block`);
    const body = css.slice(at, css.indexOf("\n}", at));
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

const base = block(":root");
const themes: Record<string, Record<string, Hsl>> = {
    dark: base,
    light: { ...base, ...block(":root.light") },
    system: { ...base, ...block("    :root.system") },
    midnight: { ...base, ...block(":root.midnight") },
    graphite: { ...base, ...block(":root.graphite") }
};
const SURFACES = ["background", "surface", "card", "elevated", "field"] as const;

describe.each(Object.entries(themes))("the %s theme", (_name, tokens) => {
    it.each(SURFACES)("draws a control's edge at 3:1 or more on %s", (surface) => {
        expect(contrast(tokens["control-edge"]!, tokens[surface]!)).toBeGreaterThanOrEqual(3);
    });

    it.each(SURFACES)("draws the focus ring at 3:1 or more on %s", (surface) => {
        expect(contrast(tokens.ring!, tokens[surface]!)).toBeGreaterThanOrEqual(3);
    });

    it.each(["card", "elevated"] as const)("keeps a section's hairline visible on %s", (surface) => {
        expect(contrast(tokens.border!, tokens[surface]!)).toBeGreaterThanOrEqual(1.3);
    });
});
