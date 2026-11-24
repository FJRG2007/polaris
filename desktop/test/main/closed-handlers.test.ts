import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

/**
 * By the time a window's "closed" event fires its contents are destroyed, and
 * reading `webContents` then throws "Object has been destroyed" in the main
 * process - a dialog on the user's screen. A handler takes what it needs from
 * the contents before the window closes.
 */
const MAIN = join(__dirname, "..", "..", "src", "main");

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return entry.name.endsWith(".ts") ? [path] : [];
    });
}

/** The names of the functions defined in `text` whose body reads `webContents`. */
function readersOfContents(text: string): Set<string> {
    const names = new Set<string>();
    const pattern = /const (\w+) = \([^)]*\) => \{([\s\S]*?)\n\s*\};/g;
    for (const match of text.matchAll(pattern)) if (/\.webContents\b/.test(match[2] ?? "")) names.add(match[1] ?? "");
    return names;
}

describe("window closed handlers", () => {
    it("never read the destroyed window's contents", () => {
        const offenders: string[] = [];
        for (const file of sources(MAIN)) {
            const text = readFileSync(file, "utf8");
            const readers = readersOfContents(text);
            for (const match of text.matchAll(/\.on\("closed", ([\s\S]*?)\);/g)) {
                const handler = match[1] ?? "";
                const named = /^\w+$/.test(handler.trim()) ? handler.trim() : null;
                if (/\.webContents\b/.test(handler) || (named && readers.has(named))) offenders.push(`${file}: ${handler.slice(0, 80)}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
