import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "" } }));

import {
    APP_CLIPBOARD_KEEPS,
    APP_SEARCH_ENGINES,
    APP_SETTINGS,
    APP_SETTING_TOGGLES,
    appSettingsTarget,
    readAppSettingChange,
    readAppSettings
} from "@polaris/core/app-settings";
import { SETTING_DEFAULTS } from "@/main/settings";
import { SEARCH_ENGINE_IDS } from "@/shared/launcher";
import { CLIPBOARD_KEEP_IDS } from "@/shared/clipboard-store";
import { PREFERENCE_TOGGLES } from "@/shared/bridge";

describe("the shared settings schema", () => {
    it("lists every switch the app keeps, with the app's own default", () => {
        const toggles = APP_SETTINGS.filter((entry) => entry.kind === "toggle").map((entry) => entry.key);
        expect([...toggles].sort()).toEqual([...APP_SETTING_TOGGLES].sort());
        expect([...APP_SETTING_TOGGLES].sort()).toEqual(
            [...PREFERENCE_TOGGLES, "openAtLogin", "hardwareAcceleration"].sort()
        );
        for (const entry of APP_SETTINGS) {
            expect(entry.default, entry.key).toEqual(SETTING_DEFAULTS[entry.key]);
        }
    });

    it("offers the choices the app accepts", () => {
        expect([...APP_SEARCH_ENGINES]).toEqual(SEARCH_ENGINE_IDS);
        expect([...APP_CLIPBOARD_KEEPS]).toEqual(CLIPBOARD_KEEP_IDS);
    });
});

describe("a change crossing the bridge", () => {
    it("is taken only with a known key and a value of its kind", () => {
        expect(readAppSettingChange({ key: "launcher", value: false })).toEqual({ key: "launcher", value: false });
        expect(readAppSettingChange({ key: "launcherEngine", value: "brave" })).toEqual({ key: "launcherEngine", value: "brave" });
        expect(readAppSettingChange({ key: "launcherEngine", value: "yahoo" })).toBeNull();
        expect(readAppSettingChange({ key: "launcher", value: "yes" })).toBeNull();
        expect(readAppSettingChange({ key: "server", value: "https://elsewhere.example" })).toBeNull();
        expect(readAppSettingChange({ key: "launcher", value: true, extra: 1 })).toBeNull();
        expect(readAppSettingChange(null)).toBeNull();
    });
});

describe("the app's answer as the page reads it", () => {
    it("falls back to the app's defaults for what an older build does not send", () => {
        const snapshot = readAppSettings({ launcher: false, version: "0.1.70" });
        expect(snapshot?.launcher).toBe(false);
        expect(snapshot?.voiceWidgetGameOnly).toBe(false);
        expect(snapshot?.launcherEngine).toBe("duckduckgo");
        expect(snapshot?.servers).toEqual([]);
        expect(readAppSettings("nope")).toBeNull();
    });
});

describe("where the settings open", () => {
    it("opens the host's Settings only on a page that said it draws them", () => {
        expect(appSettingsTarget({ pageLoaded: true, pageAnnounced: true })).toBe("host");
        // A host from before the screen existed never says so.
        expect(appSettingsTarget({ pageLoaded: true, pageAnnounced: false })).toBe("local");
        // Offline, or no host yet: nothing is loaded.
        expect(appSettingsTarget({ pageLoaded: false, pageAnnounced: false })).toBe("local");
        expect(appSettingsTarget({ pageLoaded: false, pageAnnounced: true })).toBe("local");
    });
});
