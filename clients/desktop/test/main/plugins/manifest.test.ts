import { describe, expect, it } from "vitest";
import {
    pluginDevicePresent,
    pluginFit,
    pluginPlatform,
    pluginsClaiming,
    comparePluginVersions,
    readPluginManifest,
    readPluginSettingChange,
    readPluginSettingValues
} from "@polaris/core/device-plugins";
import { catalogOf, entryFor, fixturePackage, manifest } from "./fixtures";

describe("plugin manifest", () => {
    it("reads a whole manifest", () => {
        expect(readPluginManifest(manifest)?.id).toBe("fixture-mixer");
    });

    it.each([
        ["an id with capitals", { id: "Fixture" }],
        ["no platform", { entries: {} }],
        ["an entry outside the package", { entries: { "linux-x64": "../main.js" } }],
        ["an absolute entry", { entries: { "linux-x64": "/main.js" } }],
        ["an unknown permission", { permissions: ["filesystem"] }],
        ["a repeated permission", { permissions: ["usb", "usb"] }],
        ["a USB id too large", { claims: [{ vendorId: 0x10000, productId: 1, name: "x" }] }],
        [
            "a choice whose default is not a choice",
            { settings: [{ kind: "choice", key: "mode", label: { "en-US": "Mode" }, options: [{ value: "a", label: { "en-US": "A" } }], default: "b" }] }
        ],
        ["a setting without English", { settings: [{ kind: "toggle", key: "x", label: { "es-ES": "X" }, default: true }] }],
        ["a version that is not one", { version: "1.0" }]
    ])("refuses %s", (_name, override) => {
        expect(readPluginManifest({ ...manifest, ...override })).toBeNull();
    });

    it("compares versions numerically", () => {
        expect(comparePluginVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
        expect(comparePluginVersions("0.1.73", "0.1.73")).toBe(0);
    });

    it("knows where it can run", () => {
        const entry = entryFor(fixturePackage());
        expect(pluginPlatform("linux", "x64")).toBe("linux-x64");
        expect(pluginPlatform("linux", "ia32")).toBeNull();
        expect(pluginFit(entry, "linux-x64", "0.1.73").ok).toBe(true);
        expect(pluginFit(entry, "darwin-arm64", "0.1.73")).toEqual({ ok: false, reason: "platform" });
        expect(pluginFit({ ...entry, minAppVersion: "9.0.0" }, "linux-x64", "0.1.73")).toEqual({ ok: false, reason: "app-version" });
    });

    it("matches devices to the plugins that claim them", () => {
        const entry = entryFor(fixturePackage());
        const plugged = [{ vendorId: 0x06f8, productId: 0xe053 }];
        expect(pluginDevicePresent(entry, plugged)).toBe(true);
        expect(pluginDevicePresent(entry, [{ vendorId: 1, productId: 2 }])).toBe(false);
        expect(pluginDevicePresent({ claims: [] }, [])).toBe(true);
        expect(pluginsClaiming(catalogOf([entry]), plugged).map((found) => found.claim.name)).toEqual(["Fixture device"]);
    });

    it("keeps settings inside what the plugin declares", () => {
        const settings = readPluginManifest(manifest)!.settings;
        expect(readPluginSettingValues(settings, { lights: false, stale: 1 })).toEqual({ lights: false });
        expect(readPluginSettingValues(settings, { lights: "yes" })).toEqual({ lights: true });
        expect(readPluginSettingChange(settings, "lights", false)).toEqual({ key: "lights", value: false });
        expect(readPluginSettingChange(settings, "lights", 1)).toBeNull();
        expect(readPluginSettingChange(settings, "nope", true)).toBeNull();
    });
});
