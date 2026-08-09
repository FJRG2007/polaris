/**
 * The rail inside one installed app.
 *
 * The rule being protected: standing inside a game server, the rail is that
 * server's screens rather than the Apps list - and standing inside anything else
 * installed, it is still the Apps list. An install with one screen whose rail had
 * been replaced by a list of one would be a worse place to stand than the list it
 * replaced, and it would have taken the way back with it.
 */

import { describe, expect, it } from "vitest";
import { INSTALLED_BASE, installedAppIdForPath, installedAppSubapp, isSectionActive } from "@/lib/apps";

const ID = "6f2d1c34-2b6b-4a4b-9f0e-1c2d3e4f5a6b";
const GAME_TABS = ["", "console", "players", "world", "rules", "mods", "usage", "security", "access", "settings"];

describe("installedAppIdForPath", () => {
    it("reads the id out of a path inside one", () => {
        expect(installedAppIdForPath(`${INSTALLED_BASE}/${ID}`)).toBe(ID);
        expect(installedAppIdForPath(`${INSTALLED_BASE}/${ID}/players`)).toBe(ID);
    });

    it("is null outside one, the list included", () => {
        // The list is the way back out, so it has to keep the Apps rail.
        expect(installedAppIdForPath(INSTALLED_BASE)).toBeNull();
        expect(installedAppIdForPath("/apps/games")).toBeNull();
        expect(installedAppIdForPath("/apps/deploy")).toBeNull();
    });
});

describe("installedAppSubapp", () => {
    it("is the server's own screens, under its own name, with a way back", () => {
        const subapp = installedAppSubapp(ID, { name: "Survival", tabs: GAME_TABS });
        expect(subapp).not.toBeNull();
        expect(subapp?.label).toBe("Survival");
        expect(subapp?.parent.href).toBe("/apps/games");
        expect(subapp?.sections.map((section) => section.label)).toEqual([
            "Overview",
            "Console",
            "Players",
            "World",
            "Rules",
            "Mods",
            "Usage",
            "Security",
            "Access",
            "Settings"
        ]);
    });

    it("puts the overview on the app's own path and every other screen under it", () => {
        const subapp = installedAppSubapp(ID, { name: "Survival", tabs: GAME_TABS });
        expect(subapp?.sections[0]?.href).toBe(`${INSTALLED_BASE}/${ID}`);
        expect(subapp?.sections.find((section) => section.label === "Rules")?.href).toBe(
            `${INSTALLED_BASE}/${ID}/rules`
        );
    });

    it("groups the screens rather than listing ten in a row", () => {
        const subapp = installedAppSubapp(ID, { name: "Survival", tabs: GAME_TABS });
        const groups = new Set(subapp?.sections.map((section) => section.group ?? ""));
        expect(groups.size).toBeGreaterThan(1);
    });

    it("shows only the screens this viewer was told they may open", () => {
        // Somebody invited to moderate holds neither the console nor the settings,
        // and a rail that offered them would be offering two locked doors.
        const subapp = installedAppSubapp(ID, { name: "Survival", tabs: ["", "players", "access"] });
        expect(subapp?.sections.map((section) => section.label)).toEqual(["Overview", "Players", "Access"]);
    });

    it("is nothing for an install that has no screens of its own", () => {
        expect(installedAppSubapp(ID, { name: "Messaging bridge", tabs: [] })).toBeNull();
    });

    it("lights the overview only on the overview, not on every screen below it", () => {
        const subapp = installedAppSubapp(ID, { name: "Survival", tabs: GAME_TABS });
        const sections = subapp?.sections ?? [];
        const overview = `${INSTALLED_BASE}/${ID}`;
        expect(isSectionActive(overview, overview, sections)).toBe(true);
        expect(isSectionActive(`${overview}/players`, overview, sections)).toBe(false);
        expect(isSectionActive(`${overview}/players`, `${overview}/players`, sections)).toBe(true);
    });
});
