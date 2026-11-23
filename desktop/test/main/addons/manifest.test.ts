import { describe, expect, it } from "vitest";
import {
    addonDevicePresent,
    addonFit,
    addonPlatform,
    addonsClaiming,
    compareAddonVersions,
    readAddonManifest,
    readAddonSettingChange,
    readAddonSettingValues
} from "@polaris/core/device-addons";
import { catalogOf, entryFor, fixturePackage, manifest } from "./fixtures";

describe("add-on manifest", () => {
    it("reads a whole manifest", () => {
        expect(readAddonManifest(manifest)?.id).toBe("fixture-mixer");
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
        expect(readAddonManifest({ ...manifest, ...override })).toBeNull();
    });

    it("compares versions numerically", () => {
        expect(compareAddonVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
        expect(compareAddonVersions("0.1.73", "0.1.73")).toBe(0);
    });

    it("knows where it can run", () => {
        const entry = entryFor(fixturePackage());
        expect(addonPlatform("linux", "x64")).toBe("linux-x64");
        expect(addonPlatform("linux", "ia32")).toBeNull();
        expect(addonFit(entry, "linux-x64", "0.1.73").ok).toBe(true);
        expect(addonFit(entry, "darwin-arm64", "0.1.73")).toEqual({ ok: false, reason: "platform" });
        expect(addonFit({ ...entry, minAppVersion: "9.0.0" }, "linux-x64", "0.1.73")).toEqual({ ok: false, reason: "app-version" });
    });

    it("matches devices to the add-ons that claim them", () => {
        const entry = entryFor(fixturePackage());
        const plugged = [{ vendorId: 0x06f8, productId: 0xe053 }];
        expect(addonDevicePresent(entry, plugged)).toBe(true);
        expect(addonDevicePresent(entry, [{ vendorId: 1, productId: 2 }])).toBe(false);
        expect(addonDevicePresent({ claims: [] }, [])).toBe(true);
        expect(addonsClaiming(catalogOf([entry]), plugged).map((found) => found.claim.name)).toEqual(["Fixture device"]);
    });

    it("keeps settings inside what the add-on declares", () => {
        const settings = readAddonManifest(manifest)!.settings;
        expect(readAddonSettingValues(settings, { lights: false, stale: 1 })).toEqual({ lights: false });
        expect(readAddonSettingValues(settings, { lights: "yes" })).toEqual({ lights: true });
        expect(readAddonSettingChange(settings, "lights", false)).toEqual({ key: "lights", value: false });
        expect(readAddonSettingChange(settings, "lights", 1)).toBeNull();
        expect(readAddonSettingChange(settings, "nope", true)).toBeNull();
    });
});
