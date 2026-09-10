/**
 * A status chip is drawn with the tokens made for it, never mixed at the site.
 *
 * `bg-danger/10 border-danger/40` reads as a chip on a dark card and as a smudge
 * on a white one, because one alpha cannot suit both themes. tokens.css sets the
 * soft fill, the edge and the ink per theme instead, and the Tailwind preset
 * exposes them as `bg-<status>-soft`, `border-<status>-edge`, `text-<status>-ink`.
 * A raw palette hue mixed the same way (`bg-amber-500/5`) has the same defect and
 * ignores the theme altogether, and a red that means "wrong" is the danger colour.
 *
 * Colours that name a thing rather than a state - a file type's hue, a swatch the
 * user picked, a favourite's star - stay what they are and are not matched here.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const ROOTS = [
    resolve(import.meta.dirname, "../../src"),
    resolve(import.meta.dirname, "../../../../packages/ui/src")
];

/** Where a hue is an identity: file types and the colours a user can give an item. */
const IDENTITY_FILES = new Set(["file-icons.ts", "item-icons.ts"]);

const RULES: { name: string; pattern: RegExp; allow?: (match: RegExpMatchArray) => boolean }[] = [
    {
        name: "a status tint mixed with an alpha (use bg-<status>-soft)",
        pattern: /\bbg-(success|warning|danger)\/(\d+)\b/g,
        // A deeper alpha is a shade of the solid colour - a pressed button, a graded
        // bar - not a chip's fill.
        allow: (match) => Number(match[2]) > 25
    },
    {
        name: "a status border mixed with an alpha (use border-<status>-edge)",
        pattern: /\b(border|ring|divide|outline)-(success|warning|danger)\/\d+\b/g
    },
    {
        name: "a raw hue mixed as a chip (use the status tokens)",
        pattern:
            /\b(bg|border|ring)-(red|rose|emerald|green|lime|amber|yellow|orange)-\d{2,3}\/\d+\b/g
    },
    {
        name: "a raw red for an error (use text-danger)",
        pattern: /\btext-(red|rose)-\d{2,3}\b/g
    }
];

function* sources(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) yield* sources(path);
        else if (/\.tsx?$/.test(name) && !IDENTITY_FILES.has(basename(path))) yield path;
    }
}

describe("status colours", () => {
    it("are drawn with the per-theme tokens everywhere", () => {
        const found: string[] = [];
        for (const root of ROOTS) {
            for (const file of sources(root)) {
                const text = readFileSync(file, "utf8");
                for (const rule of RULES) {
                    for (const match of text.matchAll(rule.pattern)) {
                        if (rule.allow?.(match)) continue;
                        const line = text.slice(0, match.index).split("\n").length;
                        found.push(`${relative(root, file)}:${line} ${match[0]} - ${rule.name}`);
                    }
                }
            }
        }
        expect(found).toEqual([]);
    });
});
