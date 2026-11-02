/** Official apps have an address of their own, and the old ones still arrive. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../../next.config.mjs";
import { POLARIS_APPS } from "@/lib/apps";
import { isNativeApp } from "@/lib/apps/native-apps";
import { POLARIS_APP_CATALOG, installedAppHref } from "@/lib/apps/catalog";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_ROUTES = join(WEB, "src", "app", "(app)");
/** The folder a bundle is built from, where it is not the app's id. */
const BUNDLE_DIR: Record<string, string> = { home: "places" };

const MOVED = [
    ["/apps/router", "/router"],
    ["/apps/vpn", "/vpn"],
    ["/apps/vpn/register/abc", "/vpn/register/abc"],
    ["/apps/network-filter/settings", "/network-filter/settings"],
    ["/apps/mail-server/abc", "/mail-server/abc"],
    ["/apps/games", "/game-servers"]
] as const;

interface Rule {
    source: string;
    destination: string;
    permanent: boolean;
}

function follow(rules: Rule[], path: string): Rule | undefined {
    return rules.find(({ source }) =>
        source.endsWith("/:path*") ? path.startsWith(source.slice(0, -6)) : path === source
    );
}

/** The page file that answers an address, the way the file tree spells it. */
function pageFor(dir: string, segments: readonly string[]): string | null {
    const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) =>
        entry.isDirectory()
    );
    const [head, ...rest] = segments;
    if (head === undefined && existsSync(join(dir, "page.tsx"))) return join(dir, "page.tsx");
    const exact = entries.find(({ name }) => name === head);
    const dynamic = entries.find(({ name }) => /^\[[^.[]/.test(name));
    const catchAll = entries.find(({ name }) => name.startsWith("[[..."));
    for (const entry of head === undefined ? [] : [exact, dynamic]) {
        const found = entry ? pageFor(join(dir, entry.name), rest) : null;
        if (found) return found;
    }
    return catchAll ? join(dir, catchAll.name, "page.tsx") : null;
}

/** The bundle page a web route hands its address to, when it hands it to one. */
function bundlePage(page: string): string | null {
    const call = /renderAppPage\("([^"]+)", "([^"]+)"/.exec(readFileSync(page, "utf8"));
    if (!call) return null;
    const [, surface, app] = call as unknown as [string, string, string];
    return join(
        WEB,
        "..",
        BUNDLE_DIR[app] ?? app,
        "src",
        "routes",
        ...surface.split("/"),
        "page.tsx"
    );
}

describe("official apps", () => {
    it("have no /apps prefix, except Apps itself", () => {
        const under = POLARIS_APPS.filter(
            ({ id, href }) => id !== "apps" && href.startsWith("/apps")
        );
        expect(under).toEqual([]);
    });

    it("open at a top-level address from the catalog too", () => {
        // Security scans and Cloud servers are sections of Servers, not apps of their own.
        const under = POLARIS_APP_CATALOG.filter(
            ({ id, opensAt }) => !isNativeApp(id) && opensAt?.startsWith("/apps")
        );
        expect(under).toEqual([]);
    });

    it.each(MOVED)("%s still lands, temporarily", async (from, to) => {
        const rule = follow((await config.redirects()) as Rule[], from);
        expect(rule?.permanent).toBe(false);
        const rest = from.slice(rule?.source.replace("/:path*", "").length);
        expect(rule?.destination.replace("/:path*", "") + rest).toBe(to);
    });

    it.each(MOVED)("%s lands on a page that exists", (_from, to) => {
        const page = pageFor(APP_ROUTES, to.split("/").filter(Boolean));
        expect(page).not.toBeNull();
        const bundled = bundlePage(page!);
        if (bundled) expect(existsSync(bundled)).toBe(true);
    });

    it("draw a game server at its own address and anything else at Apps", () => {
        expect(installedAppHref({ id: "a", catalogId: "minecraft" })).toBe("/game-servers/a");
        expect(installedAppHref({ id: "a", catalogId: "minecraft" }, "access")).toBe(
            "/game-servers/a/access"
        );
        expect(installedAppHref({ id: "a", catalogId: "n8n" }, "access")).toBe(
            "/apps/installed/a/access"
        );
    });
});
