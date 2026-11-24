import { describe, expect, it } from "vitest";
import { addonPagePath, addonShortcuts, sameShortcuts } from "@/main/addons/ways-in";

const stream = {
    name: "Hercules Stream 100",
    claims: [{ vendorId: 0x06f8, productId: 0xe053, name: "Hercules Stream 100" }],
    settings: [
        { kind: "toggle" as const, key: "lights", label: { "en-US": "Lights", "es-ES": "Luces" }, default: true },
        { kind: "toggle" as const, key: "pad1", label: { "en-US": "Pad 1", "es-ES": "Pad 1" }, group: "pads", default: false }
    ],
    groups: [{ key: "pads", label: { "en-US": "Pads" }, look: "buttons" as const }]
};
const pedal = { name: "A pedal", claims: [{ vendorId: 1, productId: 2, name: "Pedal" }], settings: [], groups: [] };
const plugged = [{ vendorId: 0x06f8, productId: 0xe053 }];

describe("ways to an add-on's page", () => {
    it("lists every installed add-on for the launcher, by name, and leaves out one whose files are gone", () => {
        const found = addonShortcuts(
            [
                { id: "hercules-stream100", enabled: true, manifest: stream },
                { id: "pedal", enabled: false, manifest: pedal },
                { id: "gone", enabled: true, manifest: null }
            ],
            null
        );
        expect(found.installed.map((item) => item.name)).toEqual(["A pedal", "Hercules Stream 100"]);
        expect(found.installed[1]?.path).toBe("/account/addons/hercules-stream100");
    });

    it("lists each group and setting of an add-on as a place on its page, in English, in the page's order", () => {
        const found = addonShortcuts([{ id: "hercules-stream100", enabled: true, manifest: stream }], null);
        expect(found.installed[0]?.places).toEqual([
            { label: "Lights", path: "/account/addons/hercules-stream100#setting-lights", words: [] },
            { label: "Pads", path: "/account/addons/hercules-stream100#group-pads", words: ["Pad 1"] },
            { label: "Pads - Pad 1", path: "/account/addons/hercules-stream100#setting-pad1", words: [] }
        ]);
        expect(addonShortcuts([{ id: "pedal", enabled: true, manifest: pedal }], null).installed[0]?.places).toEqual([]);
    });

    it("offers the tray item only for an enabled add-on whose device is plugged in", () => {
        const installed = [
            { id: "hercules-stream100", enabled: true, manifest: stream },
            { id: "pedal", enabled: true, manifest: pedal }
        ];
        expect(addonShortcuts(installed, plugged).plugged.map((item) => item.id)).toEqual(["hercules-stream100"]);
        expect(addonShortcuts(installed, []).plugged).toEqual([]);
        expect(addonShortcuts([{ ...installed[0]!, enabled: false }], plugged).plugged).toEqual([]);
    });

    it("offers nothing in the tray where plugs cannot be heard", () => {
        expect(addonShortcuts([{ id: "hercules-stream100", enabled: true, manifest: stream }], null).plugged).toEqual([]);
    });

    it("tells an unchanged list from a changed one", () => {
        const a = [{ id: "x", name: "X", path: addonPagePath("x"), places: [] }];
        expect(sameShortcuts(a, [{ ...a[0]! }])).toBe(true);
        expect(sameShortcuts(a, [])).toBe(false);
        expect(sameShortcuts(a, [{ ...a[0]!, name: "Y" }])).toBe(false);
    });
});
