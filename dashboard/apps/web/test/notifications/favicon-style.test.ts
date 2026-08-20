// @vitest-environment jsdom

/**
 * What the tab icon is allowed to say, and the choice behind it.
 *
 * The count is the default and has to stay the default: a reader who never opens
 * this setting is the reader most helped by being told how much is waiting.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    asFaviconStyle,
    DEFAULT_FAVICON_STYLE,
    FAVICON_STYLES,
    faviconBadge,
    faviconStyle,
    setFaviconStyle,
    onFaviconStyleChange
} from "@/lib/favicon-style";

/** jsdom leaves `window.localStorage` undefined under Node's own experimental
 *  one, so the device's store is supplied here. */
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

/** The module remembers the choice, so each case starts from a clean copy. */
async function fresh() {
    vi.resetModules();
    deviceStorage();
    return await import("@/lib/favicon-style");
}

describe("faviconBadge", () => {
    it("draws the count by default", () => {
        expect(DEFAULT_FAVICON_STYLE).toBe("count");
        expect(faviconBadge("count", 3)).toEqual({ kind: "count", label: "3" });
    });

    it("stops the count where the bell does, so a tab icon never overflows", () => {
        expect(faviconBadge("count", 10)).toEqual({ kind: "count", label: "9+" });
        expect(faviconBadge("count", 5230)).toEqual({ kind: "count", label: "9+" });
    });

    it("says only that something is waiting when asked for a dot", () => {
        expect(faviconBadge("dot", 1)).toEqual({ kind: "dot" });
        expect(faviconBadge("dot", 40)).toEqual({ kind: "dot" });
    });

    it("leaves the mark plain when nothing is waiting, whatever the choice", () => {
        for (const style of FAVICON_STYLES) expect(faviconBadge(style, 0)).toBeNull();
    });

    it("leaves the mark plain when the reader asked for nothing", () => {
        expect(faviconBadge("none", 7)).toBeNull();
    });
});

describe("asFaviconStyle", () => {
    it("keeps a choice it knows", () => {
        for (const style of FAVICON_STYLES) expect(asFaviconStyle(style)).toBe(style);
    });

    it("falls back to the count for anything else", () => {
        expect(asFaviconStyle("badge")).toBe("count");
        expect(asFaviconStyle(null)).toBe("count");
        expect(asFaviconStyle(undefined)).toBe("count");
    });
});

describe("the choice", () => {
    beforeEach(() => {
        deviceStorage();
    });

    it("is the count until this device says otherwise", async () => {
        const style = await fresh();
        expect(style.faviconStyle()).toBe("count");
    });

    it("is kept for the next visit", async () => {
        const first = await fresh();
        first.setFaviconStyle("dot");
        expect(first.faviconStyle()).toBe("dot");
        // The same device, opened again: the store is what carries it over.
        vi.resetModules();
        const later = await import("@/lib/favicon-style");
        expect(later.faviconStyle()).toBe("dot");
    });

    it("reaches the tab icon in this tab as soon as it changes", () => {
        deviceStorage();
        const told = vi.fn();
        const stop = onFaviconStyleChange(told);
        setFaviconStyle("none");
        expect(told).toHaveBeenCalledTimes(1);
        expect(faviconStyle()).toBe("none");
        stop();
        setFaviconStyle("count");
        expect(told).toHaveBeenCalledTimes(1);
    });

    it("reaches the other tabs of the browser too", async () => {
        const style = await fresh();
        const told = vi.fn();
        const stop = style.onFaviconStyleChange(told);
        // What another tab's write looks like from here.
        window.localStorage.setItem("polaris.notifications.favicon", "dot");
        window.dispatchEvent(new StorageEvent("storage", { key: "polaris.notifications.favicon" }));
        expect(told).toHaveBeenCalledTimes(1);
        expect(style.faviconStyle()).toBe("dot");
        stop();
    });

    it("ignores another tab writing something unrelated", async () => {
        const style = await fresh();
        const told = vi.fn();
        const stop = style.onFaviconStyleChange(told);
        window.dispatchEvent(new StorageEvent("storage", { key: "polaris.notifications.sound" }));
        expect(told).not.toHaveBeenCalled();
        stop();
    });
});
