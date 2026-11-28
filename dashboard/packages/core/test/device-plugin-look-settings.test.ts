import { describe, expect, it } from "vitest";
import * as plugins from "../src/device-plugins.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const SETTINGS: plugins.PluginSetting[] = [
    { kind: "color", key: "backgroundColor", group: "look", label: { "en-US": "Background" }, fallback: "#101216", default: "" },
    { kind: "image", key: "backgroundImage", group: "look", label: { "en-US": "Picture" }, width: 480, height: 272, default: "" }
];

function manifest(settings: unknown[]): unknown {
    return {
        schema: 1,
        id: "acme-mixer",
        name: "Acme Mixer",
        version: "1.0.0",
        publisher: "Acme",
        summary: "A mixer.",
        category: "devices",
        minAppVersion: "0.1.138",
        entries: { "win32-x64": "main.cjs" },
        settings
    };
}

describe("colour and picture settings", () => {
    it("keep a colour or a picture that fits and fall back to the plugin's own for anything else", () => {
        expect(plugins.readPluginSettingValues(SETTINGS, { backgroundColor: "#AABBCC", backgroundImage: PNG })).toEqual({ backgroundColor: "#AABBCC", backgroundImage: PNG });
        expect(plugins.readPluginSettingValues(SETTINGS, { backgroundColor: "red", backgroundImage: "https://example.test/a.png" })).toEqual({ backgroundColor: "", backgroundImage: "" });
        expect(plugins.readPluginSettingValues(SETTINGS, { backgroundImage: "data:image/svg+xml;base64,PHN2Zz4=" }).backgroundImage).toBe("");
    });

    it("refuse a picture over the ceiling, and take back the plugin's own with an empty value", () => {
        const huge = `data:image/png;base64,${"A".repeat(plugins.PLUGIN_IMAGE_MAX_TEXT)}`;
        expect(plugins.readPluginSettingChange(SETTINGS, "backgroundImage", huge)).toBeNull();
        expect(plugins.readPluginSettingChange(SETTINGS, "backgroundImage", "")).toEqual({ key: "backgroundImage", value: "" });
        expect(plugins.readPluginSettingChange(SETTINGS, "backgroundColor", "#00ff00")).toEqual({ key: "backgroundColor", value: "#00ff00" });
        expect(plugins.readPluginSettingChange(SETTINGS, "backgroundColor", "#00ff0")).toBeNull();
    });

    it("read a manifest that declares them, and drop a setting of a kind this build does not know instead of the manifest", () => {
        const read = plugins.readPluginManifest(manifest([...SETTINGS, { kind: "hologram", key: "later", label: { "en-US": "Later" }, default: 1 }]));
        expect(read?.settings.map((setting) => setting.key)).toEqual(["backgroundColor", "backgroundImage"]);
        expect(plugins.readPluginManifest(manifest([{ ...SETTINGS[0], default: "blue" }]))).toBeNull();
    });

    it("leave a manifest with no settings at all readable", () => {
        const bare = manifest([]) as Record<string, unknown>;
        delete bare.settings;
        expect(plugins.readPluginManifest(bare)?.settings).toEqual([]);
    });
});
