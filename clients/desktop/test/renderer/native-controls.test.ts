import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

/**
 * The app's pages never draw a browser-default control: those look like the
 * operating system, not Polaris. A dropdown is `picker()` (renderer/picker.ts),
 * a checkbox is a `.switch`, a radio a `.choice`.
 */
const RENDERER = fileURLToPath(new URL("../../src/renderer", import.meta.url));

const RULES: readonly { pattern: RegExp; use: string; }[] = [
    { pattern: /<select\b|<option\b|createElement\(\s*["'](?:select|option)["']/i, use: "a native <select>: use picker() from renderer/picker.ts" },
    { pattern: /<input\b(?![^>]*\bclass="[^"]*\bswitch\b)[^>]*type="checkbox"/i, use: 'an unstyled checkbox: give it class="switch" role="switch"' },
    { pattern: /<input\b(?![^>]*\bclass="[^"]*\bchoice\b)[^>]*type="radio"/i, use: 'an unstyled radio: give it class="choice"' },
    { pattern: /<input\b[^>]*type="(?:range|date|time|datetime-local|month|week|color)"/i, use: "a browser-default input: draw it with the app's own controls" }
];

describe("the app's pages", () => {
    const files = readdirSync(RENDERER).filter((name) => /\.(html|ts|tsx)$/.test(name));

    it("are scanned", () => expect(files.length).toBeGreaterThan(5));

    for (const name of files) {
        it(`${name} uses no browser-default control`, () => {
            // What a comment says about a control is not one.
            const source = readFileSync(join(RENDERER, name), "utf8").replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|^\s*\/\/.*$/gm, "");
            const found = RULES.filter((rule) => rule.pattern.test(source)).map((rule) => `${name}: ${rule.use}`);
            expect(found).toEqual([]);
        });
    }
});
