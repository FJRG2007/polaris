/**
 * The pure halves of the first-run setup: which apps a use recommends, which
 * sidebar a preset draws, and when the setup opens by itself.
 */

import { describe, expect, it } from "vitest";
import { findApp } from "@/lib/apps/catalog";
import { NO_LAUNCHER_PREFS } from "@/lib/app-launcher";
import {
    recommendApps,
    SETUP_APPS,
    SETUP_USE_CASES,
    shouldOfferSetup,
    USE_CASE_APPS
} from "@/lib/setup/setup-wizard";
import {
    matchPreset,
    presetAppsListed,
    presetPrefs,
    presetRail,
    SIDEBAR_PRESET_IDS,
    SIDEBAR_PRESETS
} from "@/lib/setup/sidebar-presets";

describe("sidebar presets", () => {
    it("leaves today's sidebar alone for Default", () => {
        expect(presetPrefs("default")).toEqual(NO_LAUNCHER_PREFS);
        expect(matchPreset(NO_LAUNCHER_PREFS)).toBe("default");
        expect(presetRail("default", ["chat", "tasks"])).toEqual([]);
    });

    it("round-trips every preset through the stored favorites", () => {
        for (const id of SIDEBAR_PRESET_IDS) expect(matchPreset(presetPrefs(id))).toBe(id);
    });

    it("writes the preset's apps as favorites, in order, and starts the menu order over", () => {
        expect(presetPrefs("team")).toEqual({ favorites: [...SIDEBAR_PRESETS.team], order: [] });
    });

    it("calls an edited list Custom", () => {
        expect(matchPreset({ favorites: ["chat"], order: [] })).toBe("custom");
        expect(matchPreset({ favorites: [...SIDEBAR_PRESETS.team].reverse(), order: [] })).toBe("custom");
        expect(matchPreset({ favorites: [...SIDEBAR_PRESETS.team], order: ["chat"] })).toBe("custom");
    });

    it("draws only the preset apps the reader can open, in the preset's order", () => {
        expect(presetRail("homelab", ["drive", "home", "overview", "tools"])).toEqual([
            "home",
            "drive",
            "tools"
        ]);
    });

    it("names only apps the switcher lists", () => {
        expect(presetAppsListed()).toBe(true);
    });
});

describe("setup recommendations", () => {
    it("maps each use to its apps", () => {
        expect(recommendApps(["hosting"])).toEqual(["status-pages", "security-scans", "cloud-servers"]);
        expect(recommendApps(["team"])).toEqual(["calendar", "crm"]);
        expect(recommendApps(["games"])).toEqual(["game-servers"]);
        expect(recommendApps(["homelab"])).toEqual(["security-scans", "home", "tools"]);
    });

    it("lists a shared app once, in the setup's order, and nothing for no use", () => {
        expect(recommendApps(["homelab", "hosting"])).toEqual([
            "status-pages",
            "security-scans",
            "cloud-servers",
            "home",
            "tools"
        ]);
        expect(recommendApps([])).toEqual([]);
    });

    it("recommends only catalog apps that install with one click", () => {
        for (const use of SETUP_USE_CASES)
            for (const app of USE_CASE_APPS[use]) expect(SETUP_APPS).toContain(app);
        for (const id of SETUP_APPS) expect(findApp(id)?.installMethod, id).toBe("builtin");
    });
});

describe("when the setup opens by itself", () => {
    const fresh = { isAdmin: true, viewingAs: false, mark: null, accounts: 1, appsInstalled: false };

    it("opens for the only administrator of a new Polaris", () => {
        expect(shouldOfferSetup(fresh)).toBe(true);
    });

    it("opens once: finished or skipped, it stays shut", () => {
        expect(shouldOfferSetup({ ...fresh, mark: "done" })).toBe(false);
        expect(shouldOfferSetup({ ...fresh, mark: "skipped" })).toBe(false);
    });

    it("never opens for somebody who may not install", () => {
        expect(shouldOfferSetup({ ...fresh, isAdmin: false })).toBe(false);
        expect(shouldOfferSetup({ ...fresh, viewingAs: true })).toBe(false);
    });

    it("does not ambush an established Polaris after an Update", () => {
        expect(shouldOfferSetup({ ...fresh, accounts: 2 })).toBe(false);
        expect(shouldOfferSetup({ ...fresh, appsInstalled: true })).toBe(false);
    });
});
