/**
 * The firewall's list of Polaris's own top-level paths is the app's real tree.
 *
 * `POLARIS_ROUTE_ROOTS` is what keeps the exploit packs and the probes jail off
 * Polaris's own pages and files - the Marketplace's `/logos/apps/phpmyadmin.svg`
 * once banned the operator browsing it. A new top-level page missing from the list
 * is one the firewall can mistake for a probe again; a name left on it after the
 * page is gone is a path an attacker's request is waved past for. So both
 * directions fail here.
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { POLARIS_ROUTE_ROOTS, isPolarisOwnPath } from "@polaris/core";

const WEB = resolve(__dirname, "../..");
const APP = join(WEB, "src/app");
const PUBLIC = join(WEB, "public");

/** Metadata files Next serves at the root, by the name they are served as. */
const METADATA: Record<string, string> = {
    "icon.svg": "icon.svg",
    "manifest.ts": "manifest.webmanifest",
    "robots.ts": "robots.txt",
    "sitemap.ts": "sitemap.xml",
    "favicon.ico": "favicon.ico"
};

/** What Next serves that is not in either tree. */
const FRAMEWORK = ["_next"];

/** The first segment of every route under `dir`, descending through route groups. */
function routeRoots(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = entry.name;
        if (entry.isDirectory()) {
            // An intercepting route renders another route's page; it adds no path.
            if (name.startsWith("(.")) continue;
            if (name.startsWith("(") && name.endsWith(")")) {
                found.push(...routeRoots(join(dir, name)));
                continue;
            }
            // A private folder is not a route.
            if (name.startsWith("_")) continue;
            found.push(name);
        } else if (METADATA[name]) {
            found.push(METADATA[name]);
        }
    }
    return found;
}

const actual = new Set([...routeRoots(APP), ...readdirSync(PUBLIC), ...FRAMEWORK]);

describe("Polaris's own paths, as the firewall knows them", () => {
    it("names every top-level route and public file the app serves", () => {
        const missing = [...actual].filter((root) => !POLARIS_ROUTE_ROOTS.includes(root)).sort();
        expect(missing).toEqual([]);
    });

    it("names nothing the app no longer serves", () => {
        const stale = POLARIS_ROUTE_ROOTS.filter((root) => !actual.has(root));
        expect(stale).toEqual([]);
    });

    it("has no dynamic segment at the top, which would make every path its own", () => {
        expect([...actual].filter((root) => root.startsWith("["))).toEqual([]);
    });

    it("recognises the Marketplace logo that once banned its operator", () => {
        expect(isPolarisOwnPath("/logos/apps/phpmyadmin.svg")).toBe(true);
        expect(isPolarisOwnPath("/phpmyadmin/index.php")).toBe(false);
        expect(isPolarisOwnPath("/logos/../phpmyadmin")).toBe(false);
    });
});
