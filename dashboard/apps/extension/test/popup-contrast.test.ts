/**
 * The popup's colours, read where they are defined.
 *
 * "Disconnect this browser" was red words on a red fill: the menu row carries
 * the `danger` class, and `button.danger` - the filled confirmation button -
 * matched it too. Nothing about either rule looked wrong on its own, so what is
 * pinned here is the result: which tokens each destructive control is drawn
 * with, and that every pair of text and fill the stylesheet declares reads at
 * WCAG AA (4.5:1) in both the dark and the light theme.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
    new URL("../src/entrypoints/popup/style.css", import.meta.url),
    "utf8"
).replace(/\/\*[\s\S]*?\*\//g, "");

type Theme = Record<string, string>;

/** The custom properties declared in one block of text. */
function tokensIn(block: string): Theme {
    const found: Theme = {};
    for (const match of block.matchAll(/--([a-z-]+):\s*([^;]+);/g)) found[match[1]!] = match[2]!.trim();
    return found;
}

const rootBlock = /^:root\s*\{([^}]*)\}/m.exec(CSS)![1]!;
const lightBlock = /@media \(prefers-color-scheme: light\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(CSS)![1]!;
const DARK = tokensIn(rootBlock);
const LIGHT = { ...DARK, ...tokensIn(lightBlock) };

/** Every top-level rule, by its exact selector. */
const RULES = new Map<string, string>();
for (const match of CSS.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, "").matchAll(
    /([^{}]+)\{([^}]*)\}/g
)) {
    for (const selector of match[1]!.split(",")) RULES.set(selector.trim(), match[2]!);
}

function declared(selector: string, property: string): string | null {
    const body = RULES.get(selector);
    if (!body) throw new Error(`no rule for ${selector}`);
    const found = new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`).exec(body);
    return found ? found[1]!.trim() : null;
}

type Rgb = [number, number, number];

function hsl(channels: string): Rgb {
    const [h, s, l] = channels.split(/[\s%]+/).filter(Boolean).map(Number) as [number, number, number];
    const sat = s / 100;
    const light = l / 100;
    const k = (n: number): number => (n + h / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    const f = (n: number): number =>
        light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function luminance(color: Rgb): number {
    const [r, g, b] = color.map((value) => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
}

/** A `hsl(var(--x))` or `hsl(var(--x) / a)` value, laid over the fill under it. */
function resolve(value: string, theme: Theme, under: Rgb): Rgb | null {
    const match = /^hsl\(var\(--([a-z-]+)\)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
    if (!match) return null;
    const color = hsl(theme[match[1]!]!);
    const alpha = match[2] ? Number(match[2]) : 1;
    return color.map((channel, i) => channel * alpha + under[i]! * (1 - alpha)) as Rgb;
}

const THEMES: [string, Theme][] = [
    ["dark", DARK],
    ["light", LIGHT]
];

describe("Disconnect this browser", () => {
    it("is danger words on no fill of its own, tinted only on hover", () => {
        expect(declared(".menu-item.danger", "background")).toBe("transparent");
        expect(declared(".menu-item.danger", "color")).toBe("hsl(var(--danger-ink))");
        expect(declared(".menu-item.danger:hover", "background")).toBe("hsl(var(--danger) / 0.14)");
    });

    it("reads at AA on the menu and on its hover tint, in both themes", () => {
        for (const [, theme] of THEMES) {
            const menu = hsl(theme.elevated!);
            const ink = hsl(theme["danger-ink"]!);
            expect(contrast(ink, menu)).toBeGreaterThanOrEqual(4.5);
            const hover = resolve("hsl(var(--danger) / 0.14)", theme, menu)!;
            expect(contrast(ink, hover)).toBeGreaterThanOrEqual(4.5);
        }
    });
});

describe("a filled destructive button", () => {
    it("is the solid fill with its own foreground", () => {
        expect(declared("button.danger", "background")).toBe("hsl(var(--danger-solid))");
        expect(declared("button.danger", "color")).toBe("hsl(var(--danger-foreground))");
    });

    it("has every danger token in the light theme too", () => {
        for (const token of ["danger", "danger-ink", "danger-solid", "danger-foreground"]) {
            expect(tokensIn(lightBlock)[token], token).toBeDefined();
        }
    });
});

/**
 * Colours that only ever stroke or fill a shape - the strength bar, the code's
 * countdown ring, a section's icon - are held to the 3:1 WCAG asks of graphics
 * rather than the 4.5:1 of text.
 */
const GRAPHICS = new Set([
    ".strength.weak .meter",
    ".strength.fair .meter",
    ".strength.strong .meter",
    ".ring.success",
    ".ring.warning",
    ".ring.danger",
    ".section-mark"
]);

describe("every text colour on the fill it is declared with", () => {
    // Where a rule names no fill of its own, it is drawn on the panel (`surface`)
    // or inside a menu, a dialog or a hovered row (`elevated`), so both are checked.
    const textRules = [...RULES.entries()].filter(([, body]) => /(?:^|[;\s])color:\s*hsl\(var/.test(body));

    it("finds the rules it is meant to check", () => {
        expect(textRules.length).toBeGreaterThan(20);
    });

    for (const [theme, tokens] of THEMES) {
        it(`reaches 4.5:1 for text and 3:1 for graphics in the ${theme} theme`, () => {
            const failing: string[] = [];
            for (const [selector, body] of textRules) {
                const color = /(?:^|[;\s])color:\s*([^;]+);/.exec(body)![1]!.trim();
                const background = /(?:^|[;\s])background:\s*([^;]+);/.exec(body)?.[1]?.trim();
                for (const panel of ["surface", "elevated"]) {
                    const base = hsl(tokens[panel]!);
                    const fill =
                        background && background !== "transparent"
                            ? resolve(background, tokens, base)
                            : base;
                    const text = resolve(color, tokens, fill ?? base);
                    if (!fill || !text) continue;
                    const ratio = contrast(text, fill);
                    if (ratio < (GRAPHICS.has(selector) ? 3 : 4.5)) failing.push(`${selector} on ${panel}: ${ratio.toFixed(2)}`);
                }
            }
            expect(failing).toEqual([]);
        });
    }
});
