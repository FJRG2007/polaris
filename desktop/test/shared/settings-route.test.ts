import { describe, expect, it } from "vitest";
import { HOST_UPDATE_PATH, readHostPath, readSettingsPlace, readSettingsProbe, readUpdateAccess, settingsPath, settingsRoute, type SettingsRouteState } from "@/shared/settings-route";

const HOST = "https://polaris.example.com";
const loaded: SettingsRouteState = { origin: HOST, pageLoaded: true, pageAnnounced: false, probe: null };

describe("settingsRoute", () => {
    it("asks the page that draws the settings to open the category", () => {
        expect(settingsRoute("window", { ...loaded, pageAnnounced: true })).toEqual({ kind: "page", path: "/account/app/window" });
    });

    it("asks the host first when the page has not said it draws them", () => {
        expect(settingsRoute("general", loaded)).toEqual({ kind: "probe", path: "/account/app/general" });
    });

    it("opens the host's Settings in the window when the host has the screen", () => {
        expect(settingsRoute("search", { ...loaded, probe: "present" })).toEqual({ kind: "navigate", path: "/account/app/search" });
    });

    it("opens the host's address behind its sign-in rather than the bundled page", () => {
        expect(settingsRoute("general", { ...loaded, probe: "signed-out" })).toEqual({ kind: "navigate", path: "/account/app/general" });
    });

    it("opens the bundled page, saying Polaris needs an update, on a host without the screen", () => {
        expect(settingsRoute("general", { ...loaded, probe: "missing" })).toEqual({ kind: "local", reason: "outdated" });
    });

    it("opens the bundled page, saying Polaris is out of reach, when the host does not answer", () => {
        expect(settingsRoute("general", { ...loaded, probe: "unreachable" })).toEqual({ kind: "local", reason: "offline" });
        expect(settingsRoute("general", { ...loaded, pageLoaded: false })).toEqual({ kind: "local", reason: "offline" });
    });

    it("opens the bundled page with no notice before any host", () => {
        expect(settingsRoute("general", { ...loaded, origin: null, pageAnnounced: true })).toEqual({ kind: "local", reason: null });
    });

    it("never asks a page that crashed, even one that had announced", () => {
        expect(settingsRoute("general", { ...loaded, pageLoaded: false, pageAnnounced: true }).kind).toBe("local");
    });

    it("sends the device add-ons to their own page", () => {
        expect(settingsRoute("addons", { ...loaded, probe: "present" })).toEqual({ kind: "navigate", path: "/account/addons" });
    });
});

describe("readSettingsProbe", () => {
    it.each([
        [200, "present"],
        [204, "present"],
        [307, "signed-out"],
        [302, "signed-out"],
        [404, "missing"],
        [500, "unreachable"],
        [502, "unreachable"],
        [null, "unreachable"]
    ] as const)("reads %s as %s", (status, probe) => {
        expect(readSettingsProbe(status)).toBe(probe);
    });
});

describe("host pages the bundled page may open", () => {
    it("takes every settings place and the update page", () => {
        expect(readHostPath(settingsPath("general"))).toBe("/account/app/general");
        expect(readHostPath(settingsPath("addons"))).toBe("/account/addons");
        expect(readHostPath(HOST_UPDATE_PATH)).toBe(HOST_UPDATE_PATH);
    });

    it("refuses anything else", () => {
        for (const raw of ["/account/app/nope", "/account/security", "https://evil.example/account/addons", "/account/app/general?x=1", "/account/addons/x", "", null, 3]) {
            expect(readHostPath(raw)).toBeNull();
        }
    });

    it("reads only known places", () => {
        expect(readSettingsPlace("addons")).toBe("addons");
        expect(readSettingsPlace("hosts")).toBe("hosts");
        expect(readSettingsPlace("../admin")).toBeNull();
    });
});

describe("readUpdateAccess", () => {
    it("offers the update only when the host lets this person into its update page", () => {
        expect(readUpdateAccess(200)).toBe(true);
    });

    it.each([307, 302, 303, 401, 403, 404, 500, null])("offers no update for %s", (status) => {
        // 307 is the host sending a non-administrator home, or anybody to the sign-in.
        expect(readUpdateAccess(status)).toBe(false);
    });
});
