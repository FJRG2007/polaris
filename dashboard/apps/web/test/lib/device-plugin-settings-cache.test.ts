// @vitest-environment jsdom
/**
 * A plugin's settings draw at once from what was kept (stale while revalidate):
 * per id and installed version, read again from the app behind them, swapped
 * only when they differ, and never put back to old values by a read a local
 * change overtook.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginSetting } from "@polaris/core/device-plugins";
import { cachedPluginSettings, changePluginSettings, keepPluginSettings, refreshPluginSettings, resetPluginSettingsCache } from "@/lib/device-plugins-client";

const settings = [
    { kind: "choice", key: "knob1", label: { "en-US": "Knob 1" }, default: "music", options: [{ value: "music", label: { "en-US": "Music" } }, { value: "games", label: { "en-US": "Games" } }] },
    { kind: "toggle", key: "screen", label: { "en-US": "Screen" }, default: true }
] as unknown as PluginSetting[];

/** This browser's storage, in memory: the test environment has none of its own. */
const storage = new Map<string, string>();
const memoryStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear()
};
Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage });

afterEach(() => {
    resetPluginSettingsCache();
    storage.clear();
    vi.restoreAllMocks();
});

describe("kept plugin settings", () => {
    it("are kept per id and version, and a new version reads as none kept", () => {
        expect(cachedPluginSettings("pedal", "1.0.0", settings)).toBeNull();
        keepPluginSettings("pedal", "1.0.0", { knob1: "games", screen: false });
        expect(cachedPluginSettings("pedal", "1.0.0", settings)).toEqual({ knob1: "games", screen: false });
        expect(cachedPluginSettings("pedal", "1.1.0", settings)).toBeNull();
        expect(cachedPluginSettings("other", "1.0.0", settings)).toBeNull();
    });

    it("survive a page load through storage, read back as the declared settings only", () => {
        keepPluginSettings("pedal", "1.0.0", { knob1: "games", screen: false });
        resetPluginSettingsCache();
        window.localStorage.setItem("polaris.plugin-settings.v1:pedal", JSON.stringify({ version: "1.0.0", values: { knob1: "games", screen: false, stray: 1 } }));
        expect(cachedPluginSettings("pedal", "1.0.0", settings)).toEqual({ knob1: "games", screen: false });
    });

    it("still work when storage throws", () => {
        const spy = vi.spyOn(memoryStorage, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(keepPluginSettings("pedal", "1.0.0", { knob1: "games", screen: true })).toBe(true);
        expect(cachedPluginSettings("pedal", "1.0.0", settings)).toEqual({ knob1: "games", screen: true });
        spy.mockRestore();
    });

    it("say they changed only when the values differ", () => {
        expect(keepPluginSettings("pedal", "1.0.0", { knob1: "games", screen: true })).toBe(true);
        expect(keepPluginSettings("pedal", "1.0.0", { knob1: "games", screen: true })).toBe(false);
        expect(keepPluginSettings("pedal", "1.0.0", { knob1: "music", screen: true })).toBe(true);
    });

    it("are read again from the app once for everyone asking at once, plus once more for a change heard meanwhile", async () => {
        let answer: (value: unknown) => void = () => undefined;
        const bridge = { settings: vi.fn(() => new Promise((done) => (answer = done))) };
        const first = refreshPluginSettings(bridge as never, "pedal", "1.0.0", settings);
        void refreshPluginSettings(bridge as never, "pedal", "1.0.0", settings);
        expect(bridge.settings).toHaveBeenCalledTimes(1);
        answer({ knob1: "games", screen: false });
        await first;
        expect(cachedPluginSettings("pedal", "1.0.0", settings)).toEqual({ knob1: "games", screen: false });
        await Promise.resolve();
        expect(bridge.settings).toHaveBeenCalledTimes(2);
    });

    it("are not put back by a read that began before a change made on the page", async () => {
        let answer: (value: unknown) => void = () => undefined;
        const bridge = { settings: vi.fn(() => new Promise((done) => (answer = done))) };
        keepPluginSettings("pedal", "1.0.0", { knob1: "music", screen: true });
        const read = refreshPluginSettings(bridge as never, "pedal", "1.0.0", settings);
        changePluginSettings("pedal", "1.0.0", { knob1: "games", screen: true });
        answer({ knob1: "music", screen: true });
        await read;
        expect(cachedPluginSettings("pedal", "1.0.0", settings)).toEqual({ knob1: "games", screen: true });
    });
});
