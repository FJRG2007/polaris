/**
 * What a phone does to its microphone.
 *
 * The better noise model runs a whole 16 ms frame inside one 2.7 ms slot of the
 * audio thread, and a phone's browser misses that slot: calls and voice messages
 * from the Android app came out choppy. A phone therefore starts on the
 * browser's own processing, and a phone that asks for the model gets only the
 * light one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.stubGlobal("window", {
    localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
    },
    dispatchEvent: () => true
});

const { isHandheld } = await import("@/app/(app)/chat/handheld");
const { micCleanup, setMicCleanup, CLEANUP_DEFAULT } = await import("@/app/(app)/chat/mic-cleanup");
const { modelOrder } = await import("@/app/(app)/chat/mic-filter");

const ANDROID_APP = [
    "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0",
    "Chrome/131.0.0.0 Mobile Safari/537.36 PolarisMobile/0.1.13 (Android)"
].join(" ");
const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD_AS_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const WINDOWS =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

describe("isHandheld", () => {
    it("is true for the Android app, an iPhone and an iPad that reports itself as a Mac", () => {
        expect(isHandheld({ userAgent: ANDROID_APP })).toBe(true);
        expect(isHandheld({ userAgent: IPHONE })).toBe(true);
        expect(isHandheld({ userAgent: IPAD_AS_MAC, touchPoints: 5 })).toBe(true);
    });

    it("takes the client hint over the agent string", () => {
        expect(isHandheld({ userAgent: WINDOWS, mobile: true })).toBe(true);
    });

    it("is false for a computer, a Mac with no touch screen, and no navigator at all", () => {
        expect(isHandheld({ userAgent: WINDOWS, mobile: false })).toBe(false);
        expect(isHandheld({ userAgent: IPAD_AS_MAC, touchPoints: 0 })).toBe(false);
        expect(isHandheld(null)).toBe(false);
    });
});

describe("the noise setting nobody has touched", () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    beforeEach(() => store.clear());
    afterEach(() => {
        if (real) Object.defineProperty(globalThis, "navigator", real);
    });

    function on(userAgent: string) {
        Object.defineProperty(globalThis, "navigator", {
            value: { userAgent, maxTouchPoints: 0 },
            configurable: true
        });
    }

    it("is the browser's own processing on a phone", () => {
        on(ANDROID_APP);
        expect(micCleanup()).toBe("standard");
    });

    it("is the model on a computer", () => {
        on(WINDOWS);
        expect(micCleanup()).toBe(CLEANUP_DEFAULT);
        expect(CLEANUP_DEFAULT).toBe("enhanced");
    });

    it("never overrides a choice somebody made on the phone", () => {
        on(ANDROID_APP);
        setMicCleanup("enhanced");
        expect(micCleanup()).toBe("enhanced");
        setMicCleanup("off");
        expect(micCleanup()).toBe("off");
    });
});

describe("modelOrder", () => {
    it("runs only the light model on a phone, with no heavy model to fall back to", () => {
        expect(modelOrder(true)).toEqual(["light"]);
    });

    it("keeps the better model first on a computer", () => {
        expect(modelOrder(false)).toEqual(["enhanced", "light"]);
    });
});
