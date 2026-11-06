/**
 * Every surface colour a screen names exists in the Tailwind preset.
 *
 * The preset (`packages/ui/src/tailwind-preset.ts`) gives the depth tiers as
 * single tokens - `background`, `surface`, `card`, `elevated` - plus `muted`,
 * `field` and `card-hover`. A class such as `bg-surface-raised` or
 * `hover:bg-surface-hover` compiles to nothing at all, with no warning, so the
 * element it was meant to fill is transparent: the Edit Group pencil sat over the
 * group's picture with no background behind it.
 */

import { describe, expect, it } from "vitest";
import { join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const DASHBOARD = resolve(import.meta.dirname, "../../../..");

/** Every app's sources and the shared UI package. */
function roots(): string[] {
    const apps = readdirSync(join(DASHBOARD, "apps")).map((name) =>
        join(DASHBOARD, "apps", name, "src")
    );
    return [...apps, join(DASHBOARD, "packages/ui/src")].filter((dir) => {
        try {
            return statSync(dir).isDirectory();
        } catch {
            return false;
        }
    });
}

function* sources(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) yield* sources(path);
        else if (/\.tsx?$/.test(name)) yield path;
    }
}

/** `surface` has no shades: anything after a dash is a class Tailwind never made. */
const UNDEFINED_SURFACE =
    /\b(?:bg|text|border|ring|divide|outline|from|via|to|fill|stroke)-surface-[a-z]+\b/g;

describe("surface colours", () => {
    it("are only the ones the preset defines", () => {
        const found: string[] = [];
        for (const root of roots()) {
            for (const file of sources(root)) {
                const text = readFileSync(file, "utf8");
                for (const match of text.matchAll(UNDEFINED_SURFACE)) {
                    found.push(`${relative(DASHBOARD, file)}: ${match[0]}`);
                }
            }
        }
        expect(found).toEqual([]);
    });
});
