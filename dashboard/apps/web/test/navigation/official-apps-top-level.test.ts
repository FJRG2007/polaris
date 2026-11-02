/** Official apps have an address of their own, and the old ones still arrive. */

import { describe, expect, it } from "vitest";
import config from "../../next.config.mjs";
import { POLARIS_APPS } from "@/lib/apps";
import { isNativeApp } from "@/lib/apps/native-apps";
import { POLARIS_APP_CATALOG } from "@/lib/apps/catalog";

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

describe("official apps", () => {
    it("have no /apps prefix, except Apps itself", () => {
        const under = POLARIS_APPS.filter(({ id, href }) => id !== "apps" && href.startsWith("/apps"));
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
});
