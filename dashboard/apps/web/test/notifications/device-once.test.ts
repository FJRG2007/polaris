// @vitest-environment jsdom

/**
 * The arbitration that keeps a device with several tabs open down to one chime.
 *
 * A "tab" here is a fresh copy of the module - each one picks its own identity
 * on load, which is exactly what separates two windows of the same browser - and
 * all of them are pointed at one store, because that is what the tabs of an
 * origin actually share.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The one store the tabs share. jsdom leaves `window.localStorage` undefined
 *  under Node's own experimental one, so it is supplied here rather than the
 *  module being given a seam it would not otherwise have. */
function deviceStorage() {
    const values = new Map<string, string>();
    const store = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, String(value)),
        removeItem: (key: string) => void values.delete(key),
        clear: () => values.clear(),
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() {
            return values.size;
        }
    };
    Object.defineProperty(window, "localStorage", { value: store, configurable: true, writable: true });
    return store;
}

/** Another window of the same browser: a copy of the module that picked its own
 *  identity, which is the whole of what makes two tabs two. */
async function tab() {
    vi.resetModules();
    return (await import("@/lib/device-once")).claimForDevice;
}

describe("claimForDevice", () => {
    beforeEach(() => {
        deviceStorage();
    });

    it("grants the one tab asking", async () => {
        const claim = await tab();
        await expect(claim("chime")).resolves.toBe(true);
    });

    it("grants it to exactly one of the tabs asking together", async () => {
        const [first, second, third] = [await tab(), await tab(), await tab()];
        const granted = await Promise.all([first("chime"), second("chime"), third("chime")]);
        expect(granted.filter(Boolean)).toHaveLength(1);
    });

    it("keeps a burst in one tab down to one sound", async () => {
        const claim = await tab();
        await expect(claim("chime")).resolves.toBe(true);
        await expect(claim("chime")).resolves.toBe(false);
    });

    it("lets the next arrival through once the window has passed", async () => {
        const claim = await tab();
        await expect(claim("chime", 1)).resolves.toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await expect(claim("chime", 1)).resolves.toBe(true);
    });

    it("keeps two different effects out of each other's way", async () => {
        const claim = await tab();
        await expect(claim("chime")).resolves.toBe(true);
        await expect(claim("ring")).resolves.toBe(true);
    });

    it("does not let a claim stamped in the future silence the device", async () => {
        const store = deviceStorage();
        const claim = await tab();
        store.setItem(
            "polaris.device-once:chime",
            JSON.stringify({ token: "somebody", at: Date.now() + 60_000 })
        );
        await expect(claim("chime")).resolves.toBe(true);
    });

    it("ignores a claim left by a build that shaped it differently", async () => {
        const store = deviceStorage();
        const claim = await tab();
        store.setItem("polaris.device-once:chime", "not json at all");
        await expect(claim("chime")).resolves.toBe(true);
    });

    it("runs the effect rather than dropping it when storage is unusable", async () => {
        const store = deviceStorage();
        store.getItem = () => {
            throw new Error("denied");
        };
        const claim = await tab();
        // A store that cannot be read is a device that cannot be shared, and a
        // chime nobody makes is worse than one made twice.
        await expect(claim("chime")).resolves.toBe(true);
    });

    it("runs the effect when the store refuses to be written to", async () => {
        const store = deviceStorage();
        store.setItem = () => {
            throw new Error("full");
        };
        const claim = await tab();
        await expect(claim("chime")).resolves.toBe(true);
    });
});
