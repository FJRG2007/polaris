import { describe, expect, it } from "vitest";
import { pluginListings, pluginOffer, installPlugin, type PluginsBridge } from "@/lib/device-plugins-client";
import type { PluginEntry, PluginsSnapshot } from "@polaris/core/device-plugins";

const entry = {
    id: "fixture-mixer",
    name: "Fixture mixer",
    minAppVersion: "0.1.70",
    packages: { "win32-x64": { url: "https://github.com/FJRG2007/polaris/releases/download/x/a.zip", sha256: "0".repeat(64), size: 10 } }
} as unknown as PluginEntry;

function snapshot(over: Partial<PluginsSnapshot> = {}): PluginsSnapshot {
    return { platform: "win32-x64", appVersion: "0.1.76", catalog: { schema: 1, issued: "2026-11-20T00:00:00.000Z", plugins: [entry] }, installed: [], installing: {}, ...over } as PluginsSnapshot;
}

const installed = { id: "fixture-mixer", version: "1.0.0", enabled: true, granted: [], manifest: null, update: null, run: { state: "sleeping" as const } };

describe("device plugin offers", () => {
    it("offers an install, its progress, an update, and configure", () => {
        expect(pluginOffer(snapshot(), entry.id, entry)).toEqual({ kind: "install" });
        expect(pluginOffer(snapshot({ installing: { [entry.id]: { received: 5, total: 10 } } }), entry.id, entry)).toEqual({ kind: "installing", percent: 50 });
        expect(pluginOffer(snapshot({ installing: { [entry.id]: { received: 0, total: 0 } } }), entry.id, entry)).toEqual({ kind: "installing", percent: null });
        expect(pluginOffer(snapshot({ installed: [{ ...installed, update: "1.1.0" }] }), entry.id, entry)).toEqual({ kind: "update", version: "1.1.0" });
        expect(pluginOffer(snapshot({ installed: [installed] }), entry.id, entry)).toEqual({ kind: "installed" });
    });

    it("says why it cannot install: another computer, or an older app", () => {
        expect(pluginOffer(snapshot({ platform: "linux-x64" }), entry.id, entry)).toMatchObject({ kind: "unavailable", reason: "platform" });
        expect(pluginOffer(snapshot({ appVersion: "0.1.9" }), entry.id, entry)).toEqual({ kind: "unavailable", reason: "app-version", needs: "0.1.70" });
    });

    it("lists an installed plugin the catalog dropped, and every one offline", () => {
        expect(pluginListings(snapshot({ catalog: null, installed: [installed] })).map((item) => item.id)).toEqual(["fixture-mixer"]);
        expect(pluginListings(snapshot({ installed: [{ ...installed, id: "gone-one" }] })).map((item) => item.id)).toEqual(["fixture-mixer", "gone-one"]);
    });
});

/** A desktop app's plugin bridge holding `version` (or nothing) before and `after` once `install` has run. */
function bridgeOf(options: { before: string | null; after: string | null; install: () => Promise<unknown>; enabled?: boolean }) {
    let current = options.before;
    const calls: string[] = [];
    const held = () => snapshot({ installed: current ? [{ ...installed, version: current, enabled: options.enabled ?? true }] : [] });
    const bridge = {
        get: async () => held(),
        install: async () => {
            calls.push("install");
            current = options.after;
            return options.install();
        },
        setEnabled: async (id: string, enabled: boolean) => {
            calls.push(`setEnabled:${id}:${enabled}`);
            return true;
        }
    } as unknown as PluginsBridge;
    return { bridge, calls };
}

const update = { ...entry, version: "1.1.0", permissions: [] } as unknown as PluginEntry;

describe("installing through desktop apps of every age", () => {
    it("takes the app's answer when it gives one", async () => {
        expect(await installPlugin(bridgeOf({ before: "1.0.0", after: "1.1.0", install: async () => ({ ok: true }) }).bridge, update)).toEqual({ installed: true, started: true });
        expect(await installPlugin(bridgeOf({ before: "1.0.0", after: "1.1.0", install: async () => ({ ok: true, started: false }) }).bridge, update)).toEqual({ installed: true, started: false });
        expect(await installPlugin(bridgeOf({ before: "1.0.0", after: "1.0.0", install: async () => ({ ok: false, reason: "hash" }) }).bridge, update)).toEqual({ installed: false, problem: "integrity" });
    });

    it("reads an app up to 0.1.96 that threw after the update went in as installed, and starts the new version", async () => {
        const { bridge, calls } = bridgeOf({ before: "1.0.0", after: "1.1.0", install: () => Promise.reject(new Error("EPERM: operation not permitted, rmdir")) });
        expect(await installPlugin(bridge, update)).toEqual({ installed: true, started: true });
        expect(calls).toEqual(["install", "setEnabled:fixture-mixer:true"]);
    });

    it("does not switch on a plugin that was off", async () => {
        const { bridge, calls } = bridgeOf({ before: "1.0.0", after: "1.1.0", enabled: false, install: () => Promise.reject(new Error("EPERM")) });
        expect(await installPlugin(bridge, update)).toEqual({ installed: true, started: true });
        expect(calls).toEqual(["install"]);
    });

    it("still reports a failure when the version did not change or was already there", async () => {
        expect(await installPlugin(bridgeOf({ before: "1.0.0", after: "1.0.0", install: () => Promise.reject(new Error("x")) }).bridge, update)).toEqual({ installed: false, problem: "other" });
        expect(await installPlugin(bridgeOf({ before: null, after: null, install: async () => "garbled" }).bridge, update)).toEqual({ installed: false, problem: "other" });
        expect(await installPlugin(bridgeOf({ before: "1.1.0", after: "1.1.0", install: () => Promise.reject(new Error("x")) }).bridge, update)).toEqual({ installed: false, problem: "other" });
    });
});
