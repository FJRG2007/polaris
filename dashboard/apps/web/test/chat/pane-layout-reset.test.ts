/**
 * "Reset layout" from a divider's right-click menu.
 *
 * Forgetting the stored widths is half of it; the panels already on screen hold
 * their width in their own state, so they have to be told as well. And only this
 * runtime's layout goes - the desktop app's is a separate decision, like every
 * width is.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    onLayoutReset,
    resetPaneLayout,
    storedPaneSize,
    writePaneSize
} from "@/app/(app)/chat/pane-preferences";

const BOUNDS = { min: 200, max: 400 };

/** A browser whose storage can be walked, as `resetPaneLayout` walks it. */
function browser(): Map<string, string> {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            localStorage: {
                get length() {
                    return store.size;
                },
                key: (index: number) => [...store.keys()][index] ?? null,
                getItem: (key: string) => store.get(key) ?? null,
                setItem: (key: string, value: string) => void store.set(key, value),
                removeItem: (key: string) => void store.delete(key)
            }
        }
    });
    return store;
}

describe("resetting the whole layout", () => {
    let store: Map<string, string>;

    beforeEach(() => {
        store = browser();
    });

    it("forgets every panel's width in this runtime, and nothing else", () => {
        writePaneSize("list", 320);
        writePaneSize("members", 300);
        store.set("polaris.chat.pane.list.app", "250");
        store.set("polaris.tasks.view", "board");

        resetPaneLayout();

        expect(storedPaneSize("list", BOUNDS)).toBeNull();
        expect(storedPaneSize("members", BOUNDS)).toBeNull();
        expect(store.get("polaris.chat.pane.list.app")).toBe("250");
        expect(store.get("polaris.tasks.view")).toBe("board");
    });

    it("tells the panels on screen, until they stop listening", () => {
        const heard = vi.fn();
        const stop = onLayoutReset(heard);
        resetPaneLayout();
        expect(heard).toHaveBeenCalledTimes(1);
        stop();
        resetPaneLayout();
        expect(heard).toHaveBeenCalledTimes(1);
    });

    it("still tells them when the browser refuses storage", () => {
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                get localStorage(): Storage {
                    throw new Error("denied");
                }
            }
        });
        const heard = vi.fn();
        const stop = onLayoutReset(heard);
        expect(() => resetPaneLayout()).not.toThrow();
        expect(heard).toHaveBeenCalledTimes(1);
        stop();
    });
});
