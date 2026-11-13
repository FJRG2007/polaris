/**
 * Every screen that lists Polaris's own apps by name draws each one's logo
 * beside it - the operator asked for it on the API key permissions "and the
 * same everywhere you list Polaris apps".
 *
 * Stated over the sources that turn the registry into app names on screen:
 * a client file that reads one of them must also draw a mark through the
 * shared component (`PolarisAppIcon`), or one of the logo components it is
 * built on. A file that reads one only to name a single app, or hands the list
 * to a component that draws the logos itself, is listed below with the reason.
 */

import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** The registry lists an app name is read from. */
const APP_LISTS = /\b(POLARIS_APPS|areaApp|AREA_APPS|SHORTCUT_APPS|groupByCategory|APP_LOGO_IDS)\b/;

/** What drawing an app's mark looks like. */
const MARKS = /\b(PolarisAppIcon|AppLogo|AppMark|ProductMark)\b/;

const EXEMPT: Readonly<Record<string, string>> = {
    "apps/web/src/app/(app)/app-lock/page.tsx": "names the one locked app in a heading, not a list",
    "apps/web/src/components/app-nav.tsx": "hands the apps to the switcher in @polaris/ui, which draws AppLogo"
};

function sources(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...sources(path));
        else if (entry.name.endsWith(".tsx")) found.push(path);
    }
    return found;
}

function appSources(): string[] {
    const apps = join(ROOT, "apps");
    return readdirSync(apps, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
            try {
                return sources(join(apps, entry.name, "src"));
            } catch {
                return [];
            }
        });
}

describe("lists of Polaris apps", () => {
    const files = appSources().map((path) => ({
        path: relative(ROOT, path).replace(/\\/g, "/"),
        text: readFileSync(path, "utf8")
    }));

    it("finds the screens it is about", () => {
        const listing = files.filter((file) => APP_LISTS.test(file.text)).map((file) => file.path);
        expect(listing).toContain("apps/web/src/components/permission-sections.tsx");
        expect(listing).toContain("apps/web/src/components/mcp-scope-checklist.tsx");
    });

    it("draws each app's logo beside its name", () => {
        const bare = files
            .filter((file) => APP_LISTS.test(file.text) && !MARKS.test(file.text))
            .map((file) => file.path)
            .filter((path) => !Object.hasOwn(EXEMPT, path));
        expect(bare).toEqual([]);
    });

    it("keeps no exemption for a file that no longer needs one", () => {
        const stale = Object.keys(EXEMPT).filter((path) => {
            const file = files.find((entry) => entry.path === path);
            return !file || !APP_LISTS.test(file.text) || MARKS.test(file.text);
        });
        expect(stale).toEqual([]);
    });
});
