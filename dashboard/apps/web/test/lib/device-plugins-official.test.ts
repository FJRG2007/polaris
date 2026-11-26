import { describe, expect, it, vi } from "vitest";
import { controlsByPage } from "@/app/(app)/account/plugins/official-choice-dialog";
import type { PluginManifest } from "@polaris/core/device-plugins";
import { lookOfficial, readOfficialChoice, readOfficialRestore, statusDetail, statusSentence, type PluginsBridge, type OfficialControl } from "@/lib/device-plugins-client";

const LOOK = {
    found: { app: { displayName: "Hercules Stream Control", version: "1.2" }, drivers: null, autostart: [{}], running: true },
    imported: { pages: 1, controls: [{ page: 1, slot: 1, control: "knob", official: "Apps > Multi-app volume", name: "Music", mapped: { key: "knob1", value: "music" }, kept: true }] },
    backup: null
};

function bridgeAnswering(answer: unknown): PluginsBridge {
    return { official: vi.fn(async () => answer) } as unknown as PluginsBridge;
}

describe("the official software, as the page reads the app's answers", () => {
    it("reads a look, and none from an older app or a malformed answer", async () => {
        expect((await lookOfficial(bridgeAnswering(LOOK), "hercules-stream100"))?.found?.app?.displayName).toBe("Hercules Stream Control");
        expect(await lookOfficial({} as PluginsBridge, "hercules-stream100")).toBeNull();
        expect(await lookOfficial(null, "hercules-stream100")).toBeNull();
        expect(await lookOfficial(bridgeAnswering({ found: "yes" }), "hercules-stream100")).toBeNull();
        expect(await lookOfficial({ official: () => Promise.reject(new Error("gone")) } as unknown as PluginsBridge, "x")).toBeNull();
    });

    it("words every reason a choice was not carried out, and an unknown one as a failure", () => {
        expect(readOfficialChoice({ ok: true })).toEqual({ ok: true });
        expect(readOfficialChoice({ ok: false, reason: "declined" })).toEqual({ ok: false, reason: "declined", install: null });
        expect(readOfficialChoice({ ok: false, reason: "install", install: "hash" })).toEqual({ ok: false, reason: "install", install: "integrity" });
        expect(readOfficialChoice({ ok: false, reason: "somethingNew" })).toEqual({ ok: false, reason: "failed", install: null });
        expect(readOfficialChoice(null)).toEqual({ ok: false, reason: "failed", install: null });
    });

    it("says when only the settings went back", () => {
        const base = { ok: true, autostart: 1, settings: true, started: true, missing: false, declined: false };
        expect(readOfficialRestore(base)).toBe("done");
        expect(readOfficialRestore({ ...base, missing: true, started: false })).toBe("settingsOnly");
        expect(readOfficialRestore({ ...base, ok: false, declined: true })).toBe("declined");
        expect(readOfficialRestore({ ...base, ok: false })).toBe("failed");
        expect(readOfficialRestore("nope")).toBe("failed");
    });

    it("translates only the status sentences any plugin may name", () => {
        expect(statusSentence("otherProgram")).toBe("statusDetail.otherProgram");
        expect(statusSentence("herculesDriver")).toBeNull();
        expect(statusSentence("fromTheFuture")).toBeNull();
        expect(statusSentence(undefined)).toBeNull();
    });

    it("says a status in the plugin's own words first, then the page's, then the plugin's English", () => {
        const say = (key: string, values: { device: string }) => `${key}(${values.device})`;
        const installed = { name: "Acme Mixer", statusTexts: { mixerApp: { "en-US": "Close Acme Studio.", "es-ES": "Cierra Acme Studio." } } } as unknown as PluginManifest;
        const newer = { name: "Acme Mixer", statusTexts: { mixerDriver: { "en-US": "Reinstall the Acme driver." } } } as unknown as PluginManifest;
        expect(statusDetail({ code: "mixerApp", detail: "Close it." }, [installed, newer], "es-ES", say)).toBe("Cierra Acme Studio.");
        expect(statusDetail({ code: "mixerApp", detail: "Close it." }, [installed, newer], "fr-FR", say)).toBe("Close Acme Studio.");
        // An installed version older than its words: the catalog's newer one says them.
        expect(statusDetail({ code: "mixerDriver", detail: "Driver." }, [installed, newer], "es-ES", say)).toBe("Reinstall the Acme driver.");
        expect(statusDetail({ code: "otherProgram", detail: "Busy." }, [installed, null], "es-ES", say)).toBe("statusDetail.otherProgram(Acme Mixer)");
        expect(statusDetail({ code: "fromTheFuture", detail: "Its own words." }, [null, installed], "es-ES", say)).toBe("Its own words.");
        expect(statusDetail({ code: "otherProgram", detail: "Busy." }, [null, null], "es-ES", say)).toBe("Busy.");
    });

    it("groups the imported controls by page, knobs before buttons", () => {
        const control = (page: number, kind: "knob" | "button", slot: number): OfficialControl => ({ page, slot, control: kind, official: "", name: "", mapped: null, kept: false });
        const grouped = controlsByPage([control(2, "knob", 1), control(1, "button", 1), control(1, "knob", 2), control(1, "knob", 1)]);
        expect(grouped.map(([page, list]) => [page, list.map((item) => `${item.control}${item.slot}`)])).toEqual([
            [1, ["knob1", "knob2", "button1"]],
            [2, ["knob1"]]
        ]);
    });
});
