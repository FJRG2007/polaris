import { describe, expect, it } from "vitest";
import { judgeCall } from "@/shared/plugin-protocol";
import { PLUGIN_ACTIONS, pluginText, readPluginsSnapshot } from "@polaris/core/device-plugins";
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

describe("plugins snapshot, as the page reads it", () => {
    it("reads what the app answers", () => {
        const read = readPluginsSnapshot(snapshot());
        expect(read?.catalog?.plugins[0]?.id).toBe(manifest.id);
        expect(read?.installed[0]?.manifest?.name).toBe(manifest.name);
        expect(read?.installed[0]?.run).toEqual(running);
    });

    it("keeps an installed plugin whose manifest is gone, and a broken catalog reads as none", () => {
        const read = readPluginsSnapshot(
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
        expect(readPluginsSnapshot(null)).toBeNull();
        expect(readPluginsSnapshot(snapshot({ installed: [{ id: "../x" }] }))).toBeNull();
        expect(readPluginsSnapshot(snapshot({ platform: "beos" }))).toBeNull();
    });

    it("picks the reader's language, then its base, then English", () => {
        const text = { "en-US": "Knob", "es-ES": "Rueda", fr: "Bouton" };
        expect(pluginText(text, "es-ES")).toBe("Rueda");
        expect(pluginText(text, "fr-FR")).toBe("Bouton");
        expect(pluginText(text, "de-DE")).toBe("Knob");
    });
});

describe("plugin actions", () => {
    it.each(PLUGIN_ACTIONS)("lets a plugin run the deck's %s", (action) => {
        expect(judgeCall(["polaris-actions"], "polaris.action", { action })).toMatchObject({ ok: true });
    });

    it.each(["call.record", "call.sound", "media.playPause"])("refuses %s, which a device button cannot carry", (action) => {
        expect(judgeCall(["polaris-actions"], "polaris.action", { action })).toEqual({ ok: false, error: "bad-params" });
    });
});
