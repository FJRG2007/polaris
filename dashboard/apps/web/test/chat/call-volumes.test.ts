/**
 * How loud each person is, remembered per browser.
 *
 * The interesting cases are all about a store somebody else can write. Local
 * storage belongs to whoever owns the browser, so what comes back out of it is
 * untrusted input like any other - and a NaN reaching `element.volume` throws,
 * which would take the whole call screen down rather than play somebody at the
 * wrong volume.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.stubGlobal("window", {
    localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
    },
    dispatchEvent: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    CustomEvent: class {
        constructor(
            public type: string,
            public init?: unknown
        ) {}
    }
});

const { DEFAULT_VOLUME, MAX_VOLUME, setVolumeFor, volumeFor } = await import(
    "../../src/app/(app)/chat/call-volumes"
);

beforeEach(() => store.clear());

describe("somebody nobody has adjusted", () => {
    it("is played as sent", () => {
        expect(volumeFor("ada")).toBe(DEFAULT_VOLUME);
        expect(DEFAULT_VOLUME).toBe(1);
    });
});

describe("turning somebody down", () => {
    it("is remembered against them", () => {
        setVolumeFor("ada", 0.4);
        expect(volumeFor("ada")).toBe(0.4);
        expect(volumeFor("grace")).toBe(DEFAULT_VOLUME);
    });

    it("stores nothing at all when put back to normal", () => {
        // Otherwise every person in every call anybody ever opened accumulates a
        // row saying "as sent", which is a store that only grows.
        setVolumeFor("ada", 0.4);
        setVolumeFor("ada", DEFAULT_VOLUME);
        expect(store.size).toBe(0);
        expect(volumeFor("ada")).toBe(DEFAULT_VOLUME);
    });

    it("silences at zero rather than treating it as unset", () => {
        setVolumeFor("ada", 0);
        expect(volumeFor("ada")).toBe(0);
    });
});

describe("a value out of range", () => {
    it("is clamped on the way in", () => {
        setVolumeFor("ada", 4);
        expect(volumeFor("ada")).toBe(MAX_VOLUME);
        setVolumeFor("grace", -2);
        expect(volumeFor("grace")).toBe(0);
    });

    it("is clamped on the way out, since the store is editable", () => {
        store.set("polaris.call.volume.ada", "9");
        expect(volumeFor("ada")).toBe(MAX_VOLUME);
    });
});

describe("a stored value that is not a number", () => {
    it("is treated as unset rather than passed on", () => {
        // `element.volume = NaN` throws, which would take the call screen with
        // it. Anything unreadable is somebody who was never adjusted.
        store.set("polaris.call.volume.ada", "loud");
        expect(volumeFor("ada")).toBe(DEFAULT_VOLUME);
        store.set("polaris.call.volume.ada", "");
        expect(volumeFor("ada")).toBe(DEFAULT_VOLUME);
    });
});
