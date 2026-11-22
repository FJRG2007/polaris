/**
 * The default syntax palette stays off the accent and readable on the surface
 * a code block sits on.
 *
 * Keywords were drawn in a lilac and properties in a pink, so every `def`,
 * `import`, `true` and `self` in a chat message, a Drive preview or a JSON view
 * carried the brand violet - a colour the design system spends in four places,
 * none of them code. The Polar Code themes (`[data-code-theme]`) are published
 * palettes chosen by the reader and are not held to this.
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const GLOBALS = readFileSync(resolve(import.meta.dirname, "../../src/app/globals.css"), "utf8");
const TOKENS = readFileSync(resolve(import.meta.dirname, "../../../../packages/ui/src/styles/tokens.css"), "utf8");

/** The accent's band: primary is 258, accent 275, and magenta runs on to ~345. */
const VIOLET_BAND = { from: 250, to: 345 };

type Hsl = [number, number, number];

function parseHsl(value: string): Hsl {
    const match = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/.exec(value.trim());
    if (!match) throw new Error(`not an "H S% L%" triple: ${value}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Every `--name: value` declared directly in each block opened by `selector`, in order. */
function blocks(css: string, selector: string): Map<string, string>[] {
    const found: Map<string, string>[] = [];
    for (let start = css.indexOf(`${selector} {`); start >= 0; start = css.indexOf(`${selector} {`, start + 1)) {
        const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
        found.push(new Map([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()])));
    }
    if (found.length === 0) throw new Error(`no block for ${selector}`);
    return found;
}

/** The syntax palette a selector declares - the first of its blocks that declares one. */
function codeTokens(selector: string): Map<string, string> {
    const palettes = blocks(GLOBALS, selector).map(
        (declared) => new Map([...declared].filter(([name]) => name.startsWith("code-")))
    );
    return palettes.find((palette) => palette.size > 0) ?? new Map();
}

function luminance([h, s, l]: Hsl): number {
    const sat = s / 100;
    const light = l / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    const channel = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear(channel(0)) + 0.7152 * linear(channel(8)) + 0.0722 * linear(channel(4));
}

function contrast(a: Hsl, b: Hsl): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
}

const THEMES = [
    { name: "dark", selector: ":root", surface: blocks(TOKENS, ":root")[0]!.get("muted")! },
    { name: "light", selector: ":root.light", surface: blocks(TOKENS, ":root.light")[0]!.get("muted")! },
    { name: "light (system)", selector: "    :root.system", surface: blocks(TOKENS, ":root.light")[0]!.get("muted")! }
];

describe("default syntax palette", () => {
    for (const theme of THEMES) {
        const tokens = codeTokens(theme.selector);

        it(`${theme.name}: declares the whole palette`, () => {
            expect([...tokens.keys()].sort()).toEqual(
                ["code-attr", "code-comment", "code-function", "code-keyword", "code-number", "code-string", "code-type"]
            );
        });

        it(`${theme.name}: no token is drawn in the accent's violet`, () => {
            const violet = [...tokens].filter(([, value]) => {
                const [hue] = parseHsl(value);
                return hue >= VIOLET_BAND.from && hue <= VIOLET_BAND.to;
            });
            expect(violet, "move these off the violet-to-magenta band").toEqual([]);
        });

        it(`${theme.name}: every token reads on the code block's surface`, () => {
            const surface = parseHsl(theme.surface);
            // Comments are quiet on purpose and only need to be legible.
            const faint = [...tokens].filter(
                ([name, value]) => contrast(parseHsl(value), surface) < (name === "code-comment" ? 3 : 4.5)
            );
            expect(faint, `too faint on ${theme.surface}`).toEqual([]);
        });
    }

    it("the system-light palette is the light one", () => {
        expect(codeTokens("    :root.system")).toEqual(codeTokens(":root.light"));
    });
});
