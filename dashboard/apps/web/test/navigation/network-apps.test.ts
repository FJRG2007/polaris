/**
 * The VPN, the router and the network filter are apps of their own: each one is
 * in the switcher and owns its rail, and none is reached through Apps any more.
 * Their addresses stay where they were, so bookmarks and signed-in devices work.
 */

import { describe, expect, it } from "vitest";
import { reachableApps } from "@/lib/app-access";
import { APP_SECTIONS, POLARIS_APPS, resolveActiveApp, resolveSubapp } from "@/lib/apps";

const APPS = [
    ["vpn", "/vpn", "/vpn/devices"],
    ["router", "/router", "/router"],
    ["dns-blocker", "/network-filter", "/network-filter/lists"]
] as const;

describe.each(APPS)("the %s app", (id, href, inner) => {
    it("is in the switcher at the address it always had", () => {
        expect(POLARIS_APPS.find((app) => app.id === id)?.href).toBe(href);
    });

    it("owns its screens rather than borrowing a rail from Apps", () => {
        expect(resolveActiveApp(inner).id).toBe(id);
        expect(resolveSubapp(inner)).toBeNull();
    });

    it("is not an entry in the Apps rail", () => {
        const hrefs = (APP_SECTIONS.apps ?? []).map((section) => section.href);
        expect(hrefs).not.toContain(href);
    });
});

it("finds the Network filter by what people call it", () => {
    const overview = APP_SECTIONS["dns-blocker"]?.[0];
    expect(overview?.keywords).toEqual(expect.arrayContaining(["pi-hole", "adguard", "adblock"]));
});

describe("who is offered them", () => {
    async function ids(isAdmin: boolean, installed: readonly string[]): Promise<string[]> {
        const apps = await reachableApps({
            isAdmin,
            can: async () => true,
            isInstalled: async (id) => installed.includes(id)
        });
        return apps.map((app) => app.id);
    }

    it("shows the router to an administrator with nothing installed", async () => {
        const offered = await ids(true, []);
        expect(offered).toContain("router");
        expect(offered).not.toContain("vpn");
        expect(offered).not.toContain("dns-blocker");
    });

    it("shows a member the installed VPN and neither administrator's app", async () => {
        const offered = await ids(false, ["vpn", "dns-blocker"]);
        expect(offered).toContain("vpn");
        expect(offered).not.toContain("router");
        expect(offered).not.toContain("dns-blocker");
    });

    it("does not give an account holding nothing an app of its own", async () => {
        const apps = await reachableApps({
            isAdmin: false,
            can: async () => false,
            isInstalled: async () => true
        });
        expect(apps).toEqual([]);
    });

    it("keeps the VPN beside anything else an account holds", async () => {
        const apps = await reachableApps({
            isAdmin: false,
            can: async (permission) => permission === "deploy.read",
            isInstalled: async () => true
        });
        expect(apps.map((app) => app.id)).toContain("vpn");
    });
});
