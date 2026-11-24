import { describe, expect, it } from "vitest";
import { addonPagePath, addonShortcuts, addonStatusWords, localAddonRows, sameShortcuts } from "@/main/addons/ways-in";

const stream = { name: "Hercules Stream 100", claims: [{ vendorId: 0x06f8, productId: 0xe053, name: "Hercules Stream 100" }] };
const pedal = { name: "A pedal", claims: [{ vendorId: 1, productId: 2, name: "Pedal" }] };
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
        const a = [{ id: "x", name: "X", path: addonPagePath("x") }];
        expect(sameShortcuts(a, [{ ...a[0]! }])).toBe(true);
        expect(sameShortcuts(a, [])).toBe(false);
        expect(sameShortcuts(a, [{ ...a[0]!, name: "Y" }])).toBe(false);
    });
});

describe("the app's own page's add-on rows", () => {
    it("says what a running add-on said about its device, detail included", () => {
        expect(addonStatusWords({ state: "running", status: { state: "busy", detail: "close Stream Control" } })).toBe("In use elsewhere - close Stream Control");
        expect(addonStatusWords({ state: "running", status: null })).toBe("Running");
        expect(addonStatusWords({ state: "failed", status: { state: "connected" } })).toBe("Stopped after crashing");
        expect(addonStatusWords({ state: "sleeping" })).toBe("Unplugged");
    });

    it("names a row whose files are gone by its id", () => {
        const rows = localAddonRows([{ id: "gone", version: "1.0.0", enabled: true, manifest: null, run: { state: "missing" } }]);
        expect(rows).toEqual([{ id: "gone", name: "gone", version: "1.0.0", enabled: true, status: "Files missing, reinstall it" }]);
    });
});
