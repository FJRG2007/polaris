/**
 * Every address the search can open is a page that exists: the dashboard's
 * palette (Alt+Space draws the same one on `/launcher`), the desktop
 * launcher's own page rows, and an installed app's screens. A row that leads
 * to no route is a "page not found" the reader chose from a list.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { POLARIS_APPS } from "@/lib/apps";
import { describe, expect, it } from "vitest";
import { installedAppHref } from "@/lib/apps/catalog";
import { navigationEntries } from "@/lib/search/entries";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROUTES = join(WEB, "src", "app");
const DESKTOP_LAUNCHER = join(WEB, "..", "..", "..", "clients", "desktop", "src", "main", "launcher.ts");
/** The folder a bundle is built from, where it is not the app's id. */
const BUNDLE_DIR: Record<string, string> = { home: "places" };

/** The folders of a directory, with route groups opened: `(app)` is not in an address. */
function folders(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("@") && !entry.name.startsWith("_"))
        .flatMap((entry) =>
            /^\(.+\)$/.test(entry.name) ? folders(join(dir, entry.name)).map((name) => join(entry.name, name)) : [entry.name]
        );
}

const last = (path: string) => path.split(/[\\/]/).pop() ?? "";

/** The page file that answers an address, the way the file tree spells it. */
function pageFor(dir: string, segments: readonly string[]): string | null {
    const [head, ...rest] = segments;
    const children = folders(dir);
    if (head === undefined) {
        if (existsSync(join(dir, "page.tsx"))) return join(dir, "page.tsx");
        const optional = children.find((name) => last(name).startsWith("[[..."));
        return optional && existsSync(join(dir, optional, "page.tsx")) ? join(dir, optional, "page.tsx") : null;
    }
    const exact = children.filter((name) => last(name) === head);
    const dynamic = children.filter((name) => /^\[[^.[]/.test(last(name)));
    for (const name of [...exact, ...dynamic]) {
        const found = pageFor(join(dir, name), rest);
        if (found) return found;
    }
    const catchAll = children.find((name) => /^\[\[?\.\.\./.test(last(name)));
    return catchAll && existsSync(join(dir, catchAll, "page.tsx")) ? join(dir, catchAll, "page.tsx") : null;
}

/** For a route that hands its address to an app's bundle, that bundle's page. */
function bundlePageFor(page: string, path: readonly string[], base: readonly string[]): string | null | undefined {
    const call = /renderAppPage\("([^"]+)", "([^"]+)"/.exec(readFileSync(page, "utf8"));
    if (!call) return undefined;
    const [, surface, app] = call as unknown as [string, string, string];
    const routes = join(WEB, "..", BUNDLE_DIR[app] ?? app, "src", "routes");
    return pageFor(routes, [...surface.split("/").filter(Boolean), ...path.slice(base.length)]);
}

function segmentsOf(href: string): string[] {
    return href.split(/[?#]/)[0]!.split("/").filter(Boolean);
}

/** The page rows the desktop launcher lists on its own, read from its source. */
function desktopPages(): string[] {
    const source = readFileSync(DESKTOP_LAUNCHER, "utf8");
    const block = /const PAGES[^=]*=\s*\[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
    return [...block.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1]!);
}

const palette = [
    ...new Set(navigationEntries(true, POLARIS_APPS.map((app) => app.id)).map((entry) => entry.href))
];

describe("what the search opens", () => {
    it("reads the desktop launcher's page rows", () => {
        expect(desktopPages()).toContain("/home");
    });

    it("tells a missing page from a page", () => {
        expect(pageFor(ROUTES, ["no-such-page"])).toBeNull();
        expect(pageFor(ROUTES, ["home"])).not.toBeNull();
    });

    it.each(palette)("palette row %s is a page", (href) => {
        expect(pageFor(ROUTES, segmentsOf(href))).not.toBeNull();
    });

    it.each(desktopPages())("desktop launcher row %s is a page", (href) => {
        expect(pageFor(ROUTES, segmentsOf(href))).not.toBeNull();
    });

    it.each([
        ["a game server", { id: "abc", catalogId: "minecraft" }],
        ["another installed app", { id: "abc", catalogId: "n8n" }]
    ])("%s found by name opens its own screens", (_label, install) => {
        expect(pageFor(ROUTES, segmentsOf(installedAppHref(install)))).not.toBeNull();
    });

    it("opens Game servers on the app's own list, not a missing bundle page", () => {
        const href = palette.find((entry) => entry === "/game-servers");
        expect(href).toBe("/game-servers");
        const page = pageFor(ROUTES, segmentsOf(href!));
        expect(page).not.toBeNull();
        const bundled = bundlePageFor(page!, segmentsOf(href!), ["game-servers"]);
        expect(bundled).toBeTruthy();
    });
});
