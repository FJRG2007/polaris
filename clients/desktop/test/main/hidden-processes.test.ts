import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Nothing Polaris starts in the background may flash a window: every child
 * process says `windowsHide` out loud, and only a program the person is
 * meant to see (a browser, an app they launched, the vendor's own app) may
 * say `false`. Every elevated `Start-Process` asks for a hidden window too, so
 * Windows' permission prompt is the only thing that shows.
 */

const ROOT = join(__dirname, "../../../..");
const SOURCES = [join(ROOT, "clients/desktop/src/main"), join(ROOT, "clients/device-plugins")];
const CALL = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(/g;
/** Programs started to be seen: their own window is the point. */
const SHOWN = new Map([
    ["clients/desktop/src/main/default-browser.ts", "a browser the person opens"],
    ["clients/desktop/src/main/launcher-apps.ts", "an app the person launches"],
    ["clients/desktop/src/main/plugins/official.ts", "the vendor's own app, opened from the plugin's page"],
    ["clients/desktop/src/main/updates.ts", "Polaris' own installer"]
]);

function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return files(path);
        return /\.(ts|cjs|mjs|js)$/.test(entry.name) && !/\.test\.\w+$/.test(entry.name) ? [path] : [];
    });
}

/** The text of the call starting at `open` (its opening parenthesis), up to the matching close. */
function callText(source: string, open: number): string {
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")" && --depth === 0) return source.slice(open, i + 1);
    }
    return source.slice(open);
}

const all = SOURCES.flatMap(files).map((path) => ({ path: relative(ROOT, path).replace(/\\/g, "/"), source: readFileSync(path, "utf8") }));

describe("processes Polaris starts", () => {
    it("finds the sources it checks", () => {
        expect(all.some((file) => file.path.endsWith("plugins/official.ts"))).toBe(true);
        expect(all.some((file) => file.path.endsWith("scripts/version-guard.mjs"))).toBe(true);
    });

    it("every child process states windowsHide, and false only for a program meant to be seen", () => {
        const missing: string[] = [];
        const shown: string[] = [];
        for (const { path, source } of all) {
            // Imports and type positions are not calls.
            for (const match of source.matchAll(CALL)) {
                const text = callText(source, (match.index ?? 0) + match[0].length - 1);
                const line = source.slice(0, match.index).split("\n").length;
                if (!/windowsHide\s*:/.test(text)) missing.push(`${path}:${line}`);
                else if (/windowsHide\s*:\s*false/.test(text) && !SHOWN.has(path)) shown.push(`${path}:${line}`);
            }
        }
        expect(missing).toEqual([]);
        expect(shown).toEqual([]);
    });

    it("every elevated Start-Process asks for a hidden window", () => {
        const loose: string[] = [];
        for (const { path, source } of all) {
            for (const match of source.matchAll(/Verb\s*(=\s*'RunAs'|RunAs)/gi)) {
                const around = source.slice(Math.max(0, (match.index ?? 0) - 300), (match.index ?? 0) + 300);
                if (!/WindowStyle/.test(around)) loose.push(`${path}:${source.slice(0, match.index).split("\n").length}`);
            }
        }
        expect(loose).toEqual([]);
    });
});
