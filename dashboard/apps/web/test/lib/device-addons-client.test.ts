import { describe, expect, it } from "vitest";
import { addonListings, addonOffer } from "@/lib/device-addons-client";
import type { AddonEntry, AddonsSnapshot } from "@polaris/core/device-addons";

const entry = {
    id: "fixture-mixer",
    name: "Fixture mixer",
    minAppVersion: "0.1.70",
    packages: { "win32-x64": { url: "https://github.com/FJRG2007/polaris/releases/download/x/a.zip", sha256: "0".repeat(64), size: 10 } }
} as unknown as AddonEntry;

function snapshot(over: Partial<AddonsSnapshot> = {}): AddonsSnapshot {
    return { platform: "win32-x64", appVersion: "0.1.76", catalog: { schema: 1, issued: "2026-11-20T00:00:00.000Z", addons: [entry] }, installed: [], installing: {}, ...over } as AddonsSnapshot;
}

const installed = { id: "fixture-mixer", version: "1.0.0", enabled: true, granted: [], manifest: null, update: null, run: { state: "sleeping" as const } };

describe("device add-on offers", () => {
    it("offers an install, its progress, an update, and configure", () => {
        expect(addonOffer(snapshot(), entry.id, entry)).toEqual({ kind: "install" });
        expect(addonOffer(snapshot({ installing: { [entry.id]: { received: 5, total: 10 } } }), entry.id, entry)).toEqual({ kind: "installing", percent: 50 });
        expect(addonOffer(snapshot({ installing: { [entry.id]: { received: 0, total: 0 } } }), entry.id, entry)).toEqual({ kind: "installing", percent: null });
        expect(addonOffer(snapshot({ installed: [{ ...installed, update: "1.1.0" }] }), entry.id, entry)).toEqual({ kind: "update", version: "1.1.0" });
        expect(addonOffer(snapshot({ installed: [installed] }), entry.id, entry)).toEqual({ kind: "installed" });
    });

    it("says why it cannot install: another computer, or an older app", () => {
        expect(addonOffer(snapshot({ platform: "linux-x64" }), entry.id, entry)).toMatchObject({ kind: "unavailable", reason: "platform" });
        expect(addonOffer(snapshot({ appVersion: "0.1.9" }), entry.id, entry)).toEqual({ kind: "unavailable", reason: "app-version", needs: "0.1.70" });
    });

    it("lists an installed add-on the catalog dropped, and every one offline", () => {
        expect(addonListings(snapshot({ catalog: null, installed: [installed] })).map((item) => item.id)).toEqual(["fixture-mixer"]);
        expect(addonListings(snapshot({ installed: [{ ...installed, id: "gone-one" }] })).map((item) => item.id)).toEqual(["fixture-mixer", "gone-one"]);
    });
});
