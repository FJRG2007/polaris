/**
 * A settings screen sets its text from the one scale `SettingRow` and
 * `settingType` (`@polaris/ui`) define, never from a size picked at the site.
 *
 * Chat settings showed why: its rows were drawn by hand in three sizes - 14px
 * names over 14px hints, 14px over 12px, 13px over 11px - in cards stacked one
 * above the other, and the page read as assembled from parts. A heading is not
 * a row and keeps its own size (docs/design.md, "Type"), so a line that opens
 * an `h1`-`h4` is not counted.
 *
 * Settings screens written before the shared row still carry their own sizes,
 * and `settings-type-baseline.json` holds how many each one has. The count may
 * only go down: a file may not gain one, a new file may not have any, and a
 * file that reaches zero is dropped from the baseline (the test says so) so it
 * stays there. Regenerate the baseline only by removing sizes, never to admit
 * new ones.
 */

import { describe, expect, it } from "vitest";
import baseline from "./settings-type-baseline.json";
import { join, relative, resolve, sep } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const APP = resolve(import.meta.dirname, "../../src/app/(app)");

/** A Tailwind font size: the named steps and an arbitrary rem or px value. */
const RAW_SIZE = /\btext-(?:xs|sm|base|lg|\[\d*\.?\d+(?:rem|px)\])(?![\w-])/g;
const HEADING = /<h[1-4][\s>]/;

/** Screens that are already clean and must stay clean, baseline or not. */
const STRICT = ["chat/settings/"];

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (path.endsWith(".tsx")) out.push(path);
    }
    return out;
}

/** Account, admin, and every screen under a `settings` segment. */
function isSettingsScreen(path: string): boolean {
    return /^(account|admin)\//.test(path) || /(^|\/)settings\//.test(path);
}

function countRawSizes(source: string): number {
    let count = 0;
    for (const line of source.split("\n")) {
        if (HEADING.test(line)) continue;
        count += line.match(RAW_SIZE)?.length ?? 0;
    }
    return count;
}

const files = walk(APP)
    .map((path) => relative(APP, path).split(sep).join("/"))
    .filter(isSettingsScreen);
const counts = new Map(files.map((file) => [file, countRawSizes(readFileSync(join(APP, file), "utf8"))]));
const allowed = baseline as Record<string, number>;

describe("settings type scale", () => {
    it("counts sizes and skips headings", () => {
        expect(countRawSizes('<span className="text-sm text-muted-foreground">')).toBe(1);
        expect(countRawSizes('<p className="text-[0.6875rem]">')).toBe(1);
        expect(countRawSizes('<h2 className="text-sm font-medium">')).toBe(0);
        expect(countRawSizes('<span className="text-foreground-subtle text-danger">')).toBe(0);
        expect(isSettingsScreen("chat/settings/page.tsx")).toBe(true);
        expect(isSettingsScreen("chat/call-room.tsx")).toBe(false);
    });

    it("finds the settings screens", () => {
        expect(files).toContain("chat/settings/page.tsx");
        expect(files.length).toBeGreaterThan(100);
    });

    it("keeps the migrated screens free of their own sizes", () => {
        const offenders = files.filter((file) => STRICT.some((root) => file.startsWith(root)) && counts.get(file));
        expect(offenders).toEqual([]);
    });

    it("never adds a size of its own to a settings screen", () => {
        const grown = files
            .filter((file) => (counts.get(file) ?? 0) > (allowed[file] ?? 0))
            .map((file) => `${file}: ${counts.get(file)} raw sizes, baseline ${allowed[file] ?? 0}`);
        expect(grown, "use SettingRow / settingType from @polaris/ui").toEqual([]);
    });

    it("drops a screen from the baseline once it is clean", () => {
        const stale = Object.keys(allowed).filter((file) => (counts.get(file) ?? 0) < allowed[file]!);
        expect(stale, "lower these entries in settings-type-baseline.json").toEqual([]);
    });
});
