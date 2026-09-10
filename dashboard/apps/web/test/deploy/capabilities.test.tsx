/**
 * The capabilities page lists only what exists: every entry links to a screen
 * that is really there, in the rail as well as on the page, and a screen the
 * reader cannot open is named without a link.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_SECTIONS } from "@/lib/apps";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CAPABILITY_GROUPS } from "@/lib/deploy/capabilities";
import { CapabilitiesView } from "@/app/(app)/apps/capabilities/capabilities-view";

const APP_ROUTES = resolve(__dirname, "../../src/app/(app)");

describe("the capabilities list", () => {
    it("has the seven groups, each with something in it", () => {
        expect(CAPABILITY_GROUPS.map((group) => group.title)).toEqual([
            "Deploy",
            "Run",
            "Connect",
            "Services",
            "Manage",
            "Secure",
            "Collaborate"
        ]);
        for (const group of CAPABILITY_GROUPS) expect(group.items.length).toBeGreaterThan(0);
    });

    it("links every entry to a route that exists", () => {
        const missing = CAPABILITY_GROUPS.flatMap((group) => group.items)
            .map((item) => item.href)
            .filter((href) => !existsSync(join(APP_ROUTES, href, "page.tsx")));
        expect(missing).toEqual([]);
    });

    it("is itself a route, and in the Apps rail", () => {
        expect(existsSync(join(APP_ROUTES, "apps/capabilities/page.tsx"))).toBe(true);
        expect(APP_SECTIONS.apps?.some((section) => section.href === "/apps/capabilities")).toBe(
            true
        );
    });
});

describe("the capabilities page", () => {
    const groups = CAPABILITY_GROUPS.map((group) => ({
        ...group,
        items: group.items.map((item) => ({ ...item, open: !item.adminOnly }))
    }));
    const html = renderToStaticMarkup(<CapabilitiesView groups={groups} />);

    it("numbers the groups and anchors each one", () => {
        expect(html).toContain('href="#deploy"');
        expect(html).toContain('id="collaborate"');
        expect(html).toContain(">07<");
    });

    it("links what the reader can open and names the rest without a link", () => {
        expect(html).toContain('href="/apps/firewall"');
        expect(html).not.toContain('href="/admin/activity"');
        expect(html).toContain("Management &gt; Activity - not open to you");
    });
});
