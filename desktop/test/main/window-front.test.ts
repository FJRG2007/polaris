/**
 * BUG-0005: a window the person asked for opens in front of them. The first
 * run is lifted once, and the servers window stays until Polaris is on screen.
 */

import { describe, expect, it, vi } from "vitest";
import { closeOnceShown, createPresenter, launchedByInstaller, takeFocus } from "@/main/window-front";

function liftable() {
    const calls: string[] = [];
    return {
        calls,
        show: () => calls.push("show"),
        focus: () => calls.push("focus"),
        setAlwaysOnTop: (flag: boolean) => calls.push(`top:${flag}`)
    };
}

function showable(visible: boolean, destroyed = false) {
    let listener: (() => void) | null = null;
    return {
        isDestroyed: () => destroyed,
        isVisible: () => visible,
        once: (_event: "show", next: () => void) => (listener = next),
        fireShow: () => listener?.()
    };
}

describe("windows in front", () => {
    it("knows the installer's first run, on Windows only", () => {
        expect(launchedByInstaller("win32", ["polaris.exe", "--squirrel-firstrun"])).toBe(true);
        expect(launchedByInstaller("win32", ["polaris.exe"])).toBe(false);
        expect(launchedByInstaller("darwin", ["polaris", "--squirrel-firstrun"])).toBe(false);
    });

    it("lifts the first window of the first run above everything, once", () => {
        const present = createPresenter(true);
        const first = liftable();
        const second = liftable();
        present(first);
        present(second);
        expect(first.calls).toEqual(["show", "top:true", "focus", "top:false"]);
        expect(second.calls).toEqual(["show"]);
    });

    it("only shows a window on any other start", () => {
        const window = liftable();
        createPresenter(false)(window);
        expect(window.calls).toEqual(["show"]);
    });

    it("keeps the servers window until Polaris is on screen", () => {
        const close = vi.fn();
        const polaris = showable(false);
        closeOnceShown(polaris, close);
        expect(close).not.toHaveBeenCalled();
        polaris.fireShow();
        expect(close).toHaveBeenCalledOnce();
    });

    it("closes it at once when Polaris is already showing, or there is none", () => {
        const close = vi.fn();
        closeOnceShown(showable(true), close);
        closeOnceShown(showable(false, true), close);
        closeOnceShown(null, close);
        expect(close).toHaveBeenCalledTimes(3);
    });
});

/** A window that takes focus at the `focusAt`th call to `focus()`, or never. */
function focusable(focusAt: number | null) {
    const calls: string[] = [];
    let focuses = 0;
    return {
        calls,
        show: () => calls.push("show"),
        focus: () => {
            focuses++;
            calls.push("focus");
        },
        isFocused: () => focusAt !== null && focuses >= focusAt,
        setAlwaysOnTop: (flag: boolean) => calls.push(`top:${flag}`),
        minimize: () => calls.push("minimize"),
        restore: () => calls.push("restore"),
        webContents: { focus: () => calls.push("page") }
    };
}

describe("the keyboard for a window raised from a global key", () => {
    it("stops at show and focus when Windows lets the window take it", () => {
        const window = focusable(1);
        takeFocus(window, "win32");
        expect(window.calls).toEqual(["show", "focus", "page"]);
    });

    it("flips topmost when the foreground lock refused the first focus", () => {
        const window = focusable(2);
        takeFocus(window, "win32");
        expect(window.calls).toEqual(["show", "focus", "top:false", "top:true", "focus", "page"]);
    });

    it("minimizes and restores as the last resort", () => {
        const window = focusable(null);
        takeFocus(window, "win32");
        expect(window.calls).toEqual(["show", "focus", "top:false", "top:true", "focus", "minimize", "restore", "focus", "page"]);
    });

    it("only shows and focuses elsewhere, where there is no foreground lock", () => {
        const window = focusable(null);
        takeFocus(window, "darwin");
        expect(window.calls).toEqual(["show", "focus", "page"]);
    });
});
