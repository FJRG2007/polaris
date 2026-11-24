import { describe, expect, it } from "vitest";
import { APP_SETTING_CATEGORIES } from "@polaris/core/app-settings";
import { HOST_UPDATE_ACCESS_PATH, HOST_UPDATE_PATH, hostsRoute, readHostPath, readSettingsProbe, readUpdateAccess, settingsPath, settingsRoute, type SettingsPlace, type SettingsRouteState } from "@/shared/settings-route";

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

    it("opens the host's address behind its sign-in rather than the hosts window", () => {
        expect(settingsRoute("general", { ...loaded, probe: "signed-out" })).toEqual({ kind: "navigate", path: "/account/app/general" });
    });

    it("opens the hosts window, saying Polaris needs an update, on a host without the screen", () => {
        expect(settingsRoute("general", { ...loaded, probe: "missing" })).toEqual({ kind: "local", reason: "outdated" });
    });

    it("opens the host's Settings, not the hosts window, when the host does not answer", () => {
        // Offline the window's worker draws the kept page: the same screen.
        expect(settingsRoute("general", { ...loaded, probe: "unreachable" })).toEqual({ kind: "navigate", path: "/account/app/general" });
    });

    it("opens the host's Settings when the Polaris window was closed", () => {
        const closed = { ...loaded, pageLoaded: false };
        expect(settingsRoute("clipboard", closed)).toEqual({ kind: "probe", path: "/account/app/clipboard" });
        expect(settingsRoute("clipboard", { ...closed, probe: "present" })).toEqual({ kind: "navigate", path: "/account/app/clipboard" });
        expect(settingsRoute("clipboard", { ...closed, probe: "unreachable" })).toEqual({ kind: "navigate", path: "/account/app/clipboard" });
    });

    it("opens the hosts window with no notice before any host", () => {
        expect(settingsRoute("general", { ...loaded, origin: null, pageAnnounced: true })).toEqual({ kind: "local", reason: null });
        expect(settingsRoute("general", { ...loaded, origin: null, probe: "unreachable" })).toEqual({ kind: "local", reason: null });
    });

    it("never asks a page that crashed, even one that had announced, and loads the screen there instead", () => {
        const crashed = { ...loaded, pageLoaded: false, pageAnnounced: true };
        expect(settingsRoute("general", crashed)).toEqual({ kind: "probe", path: "/account/app/general" });
        expect(settingsRoute("general", { ...crashed, probe: "present" })).toEqual({ kind: "navigate", path: "/account/app/general" });
    });

    it("opens the hosts window only for a host without the screen, or before any host", () => {
        const places: SettingsPlace[] = [...APP_SETTING_CATEGORIES, "addons"];
        const probes = [null, "present", "signed-out", "unreachable", "missing"] as const;
        for (const place of places) {
            for (const probe of probes) {
                for (const pageLoaded of [true, false]) {
                    for (const pageAnnounced of [true, false]) {
                        const route = settingsRoute(place, { origin: HOST, pageLoaded, pageAnnounced, probe });
                        const announced = pageLoaded && pageAnnounced;
                        if (route.kind === "local") expect({ probe, announced, route }).toEqual({ probe: "missing", announced: false, route: { kind: "local", reason: "outdated" } });
                        else expect(route).toHaveProperty("path", settingsPath(place));
                    }
                }
            }
        }
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

describe("host pages the hosts window may open", () => {
    it("takes the update page", () => {
        expect(readHostPath(HOST_UPDATE_PATH)).toBe(HOST_UPDATE_PATH);
    });

    it("refuses anything else, settings places included", () => {
        for (const raw of [settingsPath("general"), settingsPath("addons"), "/account/security", "https://evil.example/admin/updates", "/admin/updates?x=1", "", null, 3]) {
            expect(readHostPath(raw)).toBeNull();
        }
    });
});

describe("readUpdateAccess", () => {
    it("asks an endpoint that refuses with a status, not the streamed page that answers 200 before redirecting", () => {
        expect(HOST_UPDATE_ACCESS_PATH).toMatch(/^\/api\//);
        expect(HOST_UPDATE_ACCESS_PATH).not.toBe(HOST_UPDATE_PATH);
    });

    it("offers the update only when the host lets this person into its update page", () => {
        expect(readUpdateAccess(200)).toBe(true);
    });

    it.each([307, 302, 303, 401, 403, 404, 500, null])("offers no update for %s", (status) => {
        // 307 is the host sending a non-administrator home, or anybody to the sign-in.
        expect(readUpdateAccess(status)).toBe(false);
    });
});

describe("hostsRoute", () => {
    it("opens the page's own Hosts only when it loaded and said it draws them", () => {
        expect(hostsRoute({ pageLoaded: true, pageHosts: true })).toBe("page");
    });

    it.each([
        [{ pageLoaded: true, pageHosts: false }],
        [{ pageLoaded: false, pageHosts: true }],
        [{ pageLoaded: false, pageHosts: false }]
    ])("gives the hosts window otherwise: %o", (state) => {
        expect(hostsRoute(state)).toBe("local");
    });
});
