import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";

/**
 * The extension's own screens (popup, settings, the search over a page) never
 * draw a browser-default control: a dropdown is the popup's `Picker`
 * (entrypoints/popup/picker.tsx), never a native `<select>`.
 */
const ENTRYPOINTS = fileURLToPath(new URL("../src/entrypoints", import.meta.url));

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sources(path);
        return /\.(tsx|html)$/.test(name) ? [path] : [];
    });
}

const RULES: readonly { pattern: RegExp; use: string }[] = [
    { pattern: /<select\b|<option\b/, use: "a native <select>: use Picker from entrypoints/popup/picker.tsx" },
    { pattern: /<input\b(?![^>]*\bclassName=)[^>]*type="(?:checkbox|radio)"/, use: "an unstyled checkbox or radio: use the popup's switch" },
    { pattern: /<input\b[^>]*type="(?:date|time|datetime-local|month|week|color)"/, use: "a browser-default input: draw it with the popup's own controls" }
];

describe("the extension's screens", () => {
    const files = sources(ENTRYPOINTS);

    it("are scanned", () => expect(files.length).toBeGreaterThan(3));

    for (const path of files) {
        it(`${path.slice(ENTRYPOINTS.length + 1)} uses no browser-default control`, () => {
            // What a comment says about a control is not one.
            const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|^\s*\/\/.*$/gm, "");
            expect(RULES.filter((rule) => rule.pattern.test(source)).map((rule) => rule.use)).toEqual([]);
        });
    }
});
