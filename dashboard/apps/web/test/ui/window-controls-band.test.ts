/**
 * In the desktop app the system's minimize, maximize and close buttons are drawn
 * over the top right of the window. A screen-filling surface that starts at the
 * very top put its own top-right controls under them - the deploy service
 * panel's bell, full screen and close were there in a browser and unreachable
 * in the app (BUG-0025). Every such surface either goes through
 * `clearWindowControls` (the dialog primitives do it for every dialog) or
 * places itself against `--window-controls-height` on purpose.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";

const DASHBOARD = resolve(__dirname, "../../../..");

function walk(directory: string, found: string[] = []): string[] {
    for (const name of readdirSync(directory)) {
        if (name === "node_modules" || name === "dist" || name === "test") continue;
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path, found);
        else if (/\.tsx$/.test(name)) found.push(path);
    }
    return found;
}

/** A surface fixed to the whole window: `fixed inset-0`, minus the dimmed
 *  backdrops and the see-through layers that only catch nothing. */
const FULL_WINDOW = /["'`][^"'`]*\bfixed\b[^"'`]*\binset-0\b[^"'`]*["'`]/g;
const BACKDROP = /bg-black\/|bg-background\/|pointer-events-none|backdrop-blur/;

describe("the desktop app's window buttons", () => {
    it("never cover the top right of a surface fixed to the whole window", () => {
        const apps = join(DASHBOARD, "apps");
        const roots = [
            join(DASHBOARD, "packages/ui/src"),
            ...readdirSync(apps)
                .map((name) => join(apps, name, "src"))
                .filter((path) => {
                    try {
                        return statSync(path).isDirectory();
                    } catch {
                        return false;
                    }
                })
        ];
        const offenders: string[] = [];
        for (const path of roots.flatMap((root) => walk(root))) {
            const source = readFileSync(path, "utf8");
            for (const line of source.split("\n")) {
                for (const match of line.matchAll(FULL_WINDOW)) {
                    const classes = match[0];
                    if (BACKDROP.test(classes)) continue;
                    if (classes.includes("--window-controls-height")) continue;
                    if (/clearWindowControls\(\s*$/.test(line.slice(0, match.index))) continue;
                    offenders.push(`${path.slice(DASHBOARD.length + 1).replace(/\\/g, "/")}: ${classes}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it("start every dialog below them where it is pinned to the top", () => {
        const dialog = readFileSync(join(DASHBOARD, "packages/ui/src/components/dialog.tsx"), "utf8").replace(/\s+/g, " ");
        expect(dialog).toContain("className={clearWindowControls( cn( DIALOG_SURFACE, CENTRED_MOTION, className,");
        expect(dialog).toContain("top-[var(--window-controls-height)]");
    });
});
