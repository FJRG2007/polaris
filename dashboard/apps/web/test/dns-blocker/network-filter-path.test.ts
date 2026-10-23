/**
 * The Network filter's screens moved from /apps/dns-blocker to
 * /apps/network-filter: every old address still lands on the same screen - as
 * a redirect before anything is drawn - and nothing in the navigation points at
 * the old one.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { APP_SECTIONS, APP_SUBAPPS } from "@/lib/apps";
import config from "../../next.config.mjs";
import { describe, expect, it } from "vitest";

const SCREENS = ["", "/log", "/lists", "/devices", "/local-dns", "/settings"];

type Redirect = { source: string; destination: string; permanent: boolean };

/** Where one address is sent, matched the way Next matches `:path*`. */
function follow(rules: readonly Redirect[], path: string): string | null {
    for (const rule of rules) {
        if (rule.source === path) return rule.destination;
        if (rule.source.endsWith("/:path*")) {
            const base = rule.source.slice(0, -"/:path*".length);
            if (path.startsWith(`${base}/`))
                return rule.destination.replace(":path*", path.slice(base.length + 1));
        }
    }
    return null;
}

describe("the old Network filter address", () => {
    it("sends every screen to the same one under the new path", async () => {
        const rules = (await config.redirects()) as Redirect[];
        for (const screen of SCREENS)
            expect(follow(rules, `/apps/dns-blocker${screen}`)).toBe(
                `/apps/network-filter${screen}`
            );
        expect(follow(rules, "/apps/dns-blocker/log/extra")).toBe("/apps/network-filter/log/extra");
    });

    it("is temporary, like every other moved screen", async () => {
        const rules = (await config.redirects()) as Redirect[];
        const moved = rules.filter((rule) => rule.source.startsWith("/apps/dns-blocker"));
        expect(moved).toHaveLength(2);
        for (const rule of moved) expect(rule.permanent).toBe(false);
    });

    it("has no page left to shadow the redirect, and every new screen exists", () => {
        const apps = join(process.cwd(), "src/app/(app)/apps");
        expect(existsSync(join(apps, "dns-blocker"))).toBe(false);
        for (const screen of SCREENS)
            expect(existsSync(join(apps, `network-filter${screen}`, "page.tsx"))).toBe(true);
    });

    it("is what the navigation links to", () => {
        const hrefs = Object.values(APP_SECTIONS).flatMap((sections) =>
            sections.map((section) => section.href)
        );
        expect(hrefs.some((href) => href.startsWith("/apps/dns-blocker"))).toBe(false);
        expect(hrefs).toContain("/apps/network-filter");
        const subapp = APP_SUBAPPS.find((item) => item.id === "dns-blocker");
        expect(subapp?.base).toBe("/apps/network-filter");
        expect(subapp?.sections.map((section) => section.href)).toEqual(
            SCREENS.map((screen) => `/apps/network-filter${screen}`)
        );
    });
});
