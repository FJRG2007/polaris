/**
 * The width somebody left a panel at.
 *
 * Two things here are worth pinning, and neither is "it remembers a number".
 *
 * The first is the clamp on the way out. A limit that only exists while dragging
 * is a limit that stops existing the moment the stored value is edited by hand,
 * or the moment a panel's own limits are tightened in a later release - and what
 * comes back then is a screen that opens with one panel taking the window and no
 * divider left on it to drag back.
 *
 * The second is that a browser and the desktop app do not share one answer. They
 * are the same screen at different sizes, so a width chosen in one is usually
 * wrong in the other, and a single remembered number means every switch between
 * them lands on a layout that was decided somewhere else.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
    forgetPaneSize,
    readPaneSize,
    storedPaneSize,
    writePaneSize
} from "@/app/(app)/chat/pane-preferences";

const BOUNDS = { min: 200, max: 400, fallback: 256 };

/** Enough of a browser for this module: somewhere to put a value, and nothing
 *  claiming to be the desktop app. */
function browser(): Map<string, string> {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            localStorage: {
                getItem: (key: string) => store.get(key) ?? null,
                setItem: (key: string, value: string) => void store.set(key, value),
                removeItem: (key: string) => void store.delete(key)
            }
        }
    });
    return store;
}

/** The same, with the app's bridge on the page - checked by its members rather
 *  than by its name, which is how `isDesktopBridge` decides. */
function asDesktopApp(): void {
    const held = (globalThis as { window?: Record<string, unknown> }).window;
    if (held) {
        held.polarisDesktop = {
            version: "1.0.0",
            platform: "test",
            notify: () => Promise.resolve(true),
            closeNotice: () => Promise.resolve(),
            pickFolder: () => Promise.resolve(null),
            pushLocal: () => Promise.resolve({ ok: true }),
            openWindow: () => Promise.resolve({ ok: true })
        };
    }
}

describe("reading a remembered width", () => {
    beforeEach(() => {
        browser();
    });

    it("is the fallback for a panel nobody has touched", () => {
        expect(readPaneSize("list", BOUNDS)).toBe(256);
    });

    it("says nothing was stored, rather than answering with the fallback", () => {
        // What lets a panel whose default is a share of the screen keep that
        // share, instead of being pinned to one window's pixels forever.
        expect(storedPaneSize("list", BOUNDS)).toBeNull();
    });

    it("gives back what was written", () => {
        writePaneSize("list", 320);
        expect(readPaneSize("list", BOUNDS)).toBe(320);
        expect(storedPaneSize("list", BOUNDS)).toBe(320);
    });

    // The one that matters: a value from outside the limits must not come back.
    it("holds a stored width inside the limits, both ways", () => {
        writePaneSize("list", 4000);
        expect(readPaneSize("list", BOUNDS)).toBe(400);
        expect(storedPaneSize("list", BOUNDS)).toBe(400);

        writePaneSize("list", 4);
        expect(readPaneSize("list", BOUNDS)).toBe(200);
        expect(storedPaneSize("list", BOUNDS)).toBe(200);
    });

    it("treats anything that is not a size as never having been written", () => {
        window.localStorage.setItem("polaris.chat.pane.list.web", "wide");
        expect(readPaneSize("list", BOUNDS)).toBe(256);
        expect(storedPaneSize("list", BOUNDS)).toBeNull();
    });

    it("forgets on request", () => {
        writePaneSize("list", 320);
        forgetPaneSize("list");
        expect(storedPaneSize("list", BOUNDS)).toBeNull();
        expect(readPaneSize("list", BOUNDS)).toBe(256);
    });

    it("keeps two panels apart", () => {
        writePaneSize("list", 320);
        expect(storedPaneSize("call.direct", BOUNDS)).toBeNull();
    });
});

describe("the app and a browser tab", () => {
    it("do not share one width", () => {
        browser();
        writePaneSize("list", 320);
        expect(storedPaneSize("list", BOUNDS)).toBe(320);

        asDesktopApp();
        // Same panel, same browser storage, different runtime: the app has not
        // been told anything about how wide this should be.
        expect(storedPaneSize("list", BOUNDS)).toBeNull();

        writePaneSize("list", 220);
        expect(storedPaneSize("list", BOUNDS)).toBe(220);
    });
});

describe("a browser that refuses storage", () => {
    it("opens the screen anyway", () => {
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                get localStorage(): never {
                    // What a private window does when site data is blocked.
                    throw new Error("The operation is insecure.");
                }
            }
        });

        expect(readPaneSize("list", BOUNDS)).toBe(256);
        expect(storedPaneSize("list", BOUNDS)).toBeNull();
        // Neither of these may throw: a panel that cannot remember its width is a
        // smaller loss than a screen that will not draw.
        expect(() => writePaneSize("list", 320)).not.toThrow();
        expect(() => forgetPaneSize("list")).not.toThrow();
    });
});
