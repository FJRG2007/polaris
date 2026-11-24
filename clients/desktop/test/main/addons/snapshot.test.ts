import { describe, expect, it } from "vitest";
import { judgeCall } from "@/shared/addon-protocol";
import { ADDON_ACTIONS, addonText, readAddonsSnapshot } from "@polaris/core/device-addons";
import { catalogOf, entryFor, manifest } from "./fixtures";

const running = { state: "running", crashes: 0, status: { state: "connected" } };

function snapshot(over: Record<string, unknown> = {}) {
    return {
        platform: "win32-x64",
        appVersion: "0.1.76",
        catalog: catalogOf([entryFor(new Uint8Array([1, 2, 3]))]),
        installed: [{ id: manifest.id, version: manifest.version, enabled: true, granted: ["usb"], manifest, update: null, run: running }],
        installing: {},
        ...over
    };
}

describe("add-ons snapshot, as the page reads it", () => {
    it("reads what the app answers", () => {
        const read = readAddonsSnapshot(snapshot());
        expect(read?.catalog?.addons[0]?.id).toBe(manifest.id);
        expect(read?.installed[0]?.manifest?.name).toBe(manifest.name);
        expect(read?.installed[0]?.run).toEqual(running);
    });

    it("keeps an installed add-on whose manifest is gone, and a broken catalog reads as none", () => {
        const read = readAddonsSnapshot(
            snapshot({
                catalog: { schema: 2 },
                installed: [{ id: manifest.id, version: "1.0.0", enabled: false, granted: [], manifest: { broken: true }, update: "1.1.0", run: { state: "missing" } }]
            })
        );
        expect(read?.catalog).toBeNull();
        expect(read?.installed[0]?.manifest).toBeNull();
        expect(read?.installed[0]?.update).toBe("1.1.0");
    });

    it("refuses an answer of another shape", () => {
        expect(readAddonsSnapshot(null)).toBeNull();
        expect(readAddonsSnapshot(snapshot({ installed: [{ id: "../x" }] }))).toBeNull();
        expect(readAddonsSnapshot(snapshot({ platform: "beos" }))).toBeNull();
    });

    it("picks the reader's language, then its base, then English", () => {
        const text = { "en-US": "Knob", "es-ES": "Rueda", fr: "Bouton" };
        expect(addonText(text, "es-ES")).toBe("Rueda");
        expect(addonText(text, "fr-FR")).toBe("Bouton");
        expect(addonText(text, "de-DE")).toBe("Knob");
    });
});

describe("add-on actions", () => {
    it.each(ADDON_ACTIONS)("lets an add-on run the deck's %s", (action) => {
        expect(judgeCall(["polaris-actions"], "polaris.action", { action })).toMatchObject({ ok: true });
    });

    it.each(["call.record", "call.sound", "media.playPause"])("refuses %s, which a device button cannot carry", (action) => {
        expect(judgeCall(["polaris-actions"], "polaris.action", { action })).toEqual({ ok: false, error: "bad-params" });
    });
});
