/**
 * Device add-ons in the search. The rules being protected: an add-on installed
 * on this device is found by its name and leads to its page; each setting it
 * declares, and each group they are drawn in, is found too and leads to that
 * place on the page; the catalog's
 * others are listed apart, as add-ons to install, and never twice; and a page
 * with no desktop app behind it (installed unknown) lists only those.
 */

import { describe, expect, it } from "vitest";
import * as core from "@polaris/core";
import { addonEntries, addonHref, type AddonSearchWords } from "@/lib/search/addon-entries";
import { COMMAND_ENTRY_FIELDS } from "@/lib/search/entries";
import type { AddonCatalog, AddonEntry, AddonManifest, InstalledAddon } from "@polaris/core/device-addons";

const manifest = {
    schema: 1,
    id: "fixture-mixer",
    name: "Fixture Mixer 100",
    version: "1.0.0",
    publisher: "Fixture Labs",
    summary: "Volume knobs for a test device.",
    category: "devices",
    minAppVersion: "0.1.70",
    entries: { "win32-x64": "main.cjs" },
    claims: [{ vendorId: 1, productId: 2, name: "Fixture Mixer USB" }],
    permissions: [],
    settings: [
        { kind: "toggle", key: "enabled", label: { "en-US": "Use the mixer" }, default: true },
        {
            kind: "choice",
            key: "knob1",
            label: { "en-US": "Knob 1", "es-ES": "Rueda 1" },
            options: [{ value: "calls", label: { "en-US": "Calls", "es-ES": "Llamadas" } }],
            default: "calls"
        },
        { kind: "toggle", key: "pad1", label: { "en-US": "Pad 1" }, group: "pads", default: false }
    ],
    groups: [{ key: "pads", label: { "en-US": "Pads", "es-ES": "Botones" }, hint: { "en-US": "The square buttons" }, look: "buttons" }]
} as unknown as AddonManifest;

const other = { ...manifest, id: "fixture-pedal", name: "Fixture Pedal", settings: [], claims: [] } as unknown as AddonEntry;
const catalog = { schema: 1, issued: "2026-11-20T00:00:00.000Z", addons: [{ ...manifest } as unknown as AddonEntry, other] } as AddonCatalog;
const installed = { id: "fixture-mixer", version: "1.0.0", enabled: true, granted: [], manifest, update: null, run: { state: "sleeping" } } as InstalledAddon;

const words: AddonSearchWords = {
    installed: "Device add-ons",
    catalog: "Add-ons to install",
    setting: (name) => `Setting of ${name}`,
    section: (name) => `Settings of ${name}`,
    offer: (publisher, summary) => `By ${publisher} - ${summary}`,
    keywords: ["add-on"]
};

function find(entries: ReturnType<typeof addonEntries>, query: string) {
    return core.searchItems(entries, query, COMMAND_ENTRY_FIELDS, { limit: 10 });
}

describe("addonEntries", () => {
    it("lists an installed add-on by name, leading to its page", () => {
        const entries = addonEntries({ installed: [installed], catalog, locale: "en-US" }, words);
        const page = entries.find((entry) => entry.id === "addon:fixture-mixer");
        expect(page).toMatchObject({ label: "Fixture Mixer 100", group: "Device add-ons", href: "/account/addons/fixture-mixer" });
        expect(find(entries, "fixture mixer")[0]?.id).toBe("addon:fixture-mixer");
        // The USB device it drives finds it too.
        expect(find(entries, "Mixer USB").map((entry) => entry.id)).toContain("addon:fixture-mixer");
    });

    it("lists each declared setting, leading to that setting, in the reader's language", () => {
        const entries = addonEntries({ installed: [installed], catalog, locale: "es-ES" }, words);
        const knob = entries.find((entry) => entry.id === "addon-setting:fixture-mixer:knob1");
        expect(knob).toMatchObject({ label: "Fixture Mixer 100 - Rueda 1", href: "/account/addons/fixture-mixer#setting-knob1", context: "Setting of Fixture Mixer 100" });
        expect(entries.find((entry) => entry.id === "addon-setting:fixture-mixer:enabled")?.label).toBe("Fixture Mixer 100 - Use the mixer");
        expect(find(entries, "llamadas").map((entry) => entry.id)).toContain("addon-setting:fixture-mixer:knob1");
    });

    it("lists each group of settings, leading to its section, and finds a setting by its group", () => {
        const entries = addonEntries({ installed: [installed], catalog, locale: "es-ES" }, words);
        const group = entries.find((entry) => entry.id === "addon-group:fixture-mixer:pads");
        expect(group).toMatchObject({ label: "Fixture Mixer 100 - Botones", href: "/account/addons/fixture-mixer#group-pads", context: "Settings of Fixture Mixer 100" });
        const pad = entries.find((entry) => entry.id === "addon-setting:fixture-mixer:pad1");
        expect(pad).toMatchObject({ label: "Fixture Mixer 100 - Botones - Pad 1", href: "/account/addons/fixture-mixer#setting-pad1" });
        // A group is found by its hint and by the settings in it.
        expect(find(entries, "square buttons").map((entry) => entry.id)).toContain("addon-group:fixture-mixer:pads");
        expect(find(entries, "botones").map((entry) => entry.id)).toContain("addon-setting:fixture-mixer:pad1");
    });

    it("lists the catalog's others apart, and an installed one never as one to install", () => {
        const entries = addonEntries({ installed: [installed], catalog, locale: "en-US" }, words);
        const offers = entries.filter((entry) => entry.group === "Add-ons to install");
        expect(offers.map((entry) => entry.id)).toEqual(["addon-offer:fixture-pedal"]);
        expect(offers[0]).toMatchObject({ href: "/account/addons/fixture-pedal", context: "By Fixture Labs - Volume knobs for a test device." });
        const ids = entries.map((entry) => entry.id);
        expect(ids.length).toBe(new Set(ids).size);
    });

    it("lists only add-ons to install where the device is unknown", () => {
        const entries = addonEntries({ installed: null, catalog, locale: "en-US" }, words);
        expect(entries.map((entry) => entry.id)).toEqual(["addon-offer:fixture-mixer", "addon-offer:fixture-pedal"]);
        expect(entries.every((entry) => entry.group === "Add-ons to install")).toBe(true);
    });

    it("falls back to the catalog's name when the files on the device are not read, and lists no settings then", () => {
        const entries = addonEntries({ installed: [{ ...installed, manifest: null }], catalog, locale: "en-US" }, words);
        expect(entries.filter((entry) => entry.group === "Device add-ons").map((entry) => entry.id)).toEqual(["addon:fixture-mixer"]);
        // Neither files nor a catalog entry: nothing to name it by, so nothing listed.
        expect(addonEntries({ installed: [{ ...installed, id: "gone-one", manifest: null }], catalog: null, locale: "en-US" }, words)).toEqual([]);
    });

    it("keeps an id that needs escaping inside its path", () => {
        expect(addonHref("a b")).toBe("/account/addons/a%20b");
    });
});
