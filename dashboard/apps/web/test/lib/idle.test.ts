// @vitest-environment jsdom

/**
 * Nothing moves while nobody can be looking - and everything moves while
 * somebody can.
 *
 * Hidden, minimized or in the tray puts `data-idle` on `<html>` (which pauses
 * the CSS loops) and stops the script loops that ask to be stopped. A window
 * that only lost focus is still on screen, so it keeps animating. The desktop
 * app says when its window is minimized; an app too old to say falls back to
 * the window's focus, as it did before.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { animateWhileAwake, IDLE_ATTRIBUTE, isIdle, readIdle, watchIdle } from "@/lib/idle";

let focused = true;
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
    vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"]
    });
    focused = true;
    visibility = "visible";
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as { polarisDesktop?: unknown }).polarisDesktop;
});

const marked = () => document.documentElement.hasAttribute(IDLE_ATTRIBUTE);

function blur() {
    focused = false;
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(1);
}

function focus() {
    focused = true;
    window.dispatchEvent(new Event("focus"));
}

function hide() {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
}

function show() {
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
}

/** The desktop app's bridge, with or without the window report. */
function desktop({ reports }: { reports: boolean }) {
    let listener: ((shown: boolean) => void) | null = null;
    const noop = async () => undefined;
    (window as { polarisDesktop?: unknown }).polarisDesktop = {
        version: "0.1.33",
        platform: "win32",
        notify: noop,
        closeNotice: noop,
        pickFolder: noop,
        pushLocal: noop,
        openWindow: noop,
        ...(reports
            ? {
                  onWindowShown: (heard: (shown: boolean) => void) => {
                      listener = heard;
                      return () => {
                          listener = null;
                      };
                  }
              }
            : {})
    };
    return { tell: (shown: boolean) => listener?.(shown), listening: () => listener !== null };
}

describe("the idle mark in a browser", () => {
    it("reads only a hidden page as idle", () => {
        expect(readIdle()).toBe(false);
        focused = false;
        expect(readIdle()).toBe(false);
        visibility = "hidden";
        expect(readIdle()).toBe(true);
    });

    it("keeps animating when the window only loses focus", () => {
        const stop = watchIdle();
        blur();
        expect(marked()).toBe(false);
        expect(isIdle()).toBe(false);
        stop();
    });

    it("follows the document's visibility", () => {
        const stop = watchIdle();
        hide();
        expect(marked()).toBe(true);
        show();
        expect(marked()).toBe(false);
        stop();
    });

    it("starts awake in a window opened in the background but on screen", () => {
        focused = false;
        const stop = watchIdle();
        expect(marked()).toBe(false);
        stop();
    });

    it("is removed only when the last watcher stops", () => {
        const first = watchIdle();
        const second = watchIdle();
        hide();
        first();
        expect(marked()).toBe(true);
        second();
        expect(marked()).toBe(false);
    });
});

describe("the idle mark in the desktop app", () => {
    it("follows the window minimized and restored, not its focus", () => {
        const app = desktop({ reports: true });
        const stop = watchIdle();
        blur();
        expect(marked()).toBe(false);
        app.tell(false);
        expect(marked()).toBe(true);
        app.tell(true);
        expect(marked()).toBe(false);
        stop();
        expect(app.listening()).toBe(false);
    });

    it("falls back to the window's focus in an app too old to report it", () => {
        desktop({ reports: false });
        const stop = watchIdle();
        blur();
        expect(marked()).toBe(true);
        focus();
        expect(marked()).toBe(false);
        stop();
    });

    it("stays awake in an old app when focus only moved into a frame of the page", () => {
        desktop({ reports: false });
        const stop = watchIdle();
        window.dispatchEvent(new Event("blur"));
        vi.advanceTimersByTime(1);
        expect(marked()).toBe(false);
        stop();
    });
});

describe("animateWhileAwake", () => {
    it("draws every frame while awake and none while idle", () => {
        const frame = vi.fn();
        const stop = animateWhileAwake(frame);
        vi.advanceTimersByTime(100);
        const awake = frame.mock.calls.length;
        expect(awake).toBeGreaterThan(2);

        blur();
        vi.advanceTimersByTime(100);
        expect(frame.mock.calls.length).toBeGreaterThan(awake);

        hide();
        const atHide = frame.mock.calls.length;
        vi.advanceTimersByTime(500);
        expect(frame.mock.calls.length).toBe(atHide);

        show();
        vi.advanceTimersByTime(100);
        expect(frame.mock.calls.length).toBeGreaterThan(atHide);

        stop();
        const atStop = frame.mock.calls.length;
        vi.advanceTimersByTime(500);
        expect(frame.mock.calls.length).toBe(atStop);
    });

    it("never starts in a page that is already hidden", () => {
        visibility = "hidden";
        const frame = vi.fn();
        const stop = animateWhileAwake(frame);
        vi.advanceTimersByTime(500);
        expect(frame).not.toHaveBeenCalled();
        stop();
    });
});

describe("the stylesheet", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

    it("pauses animations under the idle mark, sparing closing menus and the call ring", () => {
        const rule = css.match(/:root\[data-idle\][^{]*\{[^}]*\}/)?.[0] ?? "";
        expect(rule).toContain("animation-play-state: paused !important");
        expect(rule).toContain(":not([data-state])");
        expect(rule).toContain(":not(.call-ring-pulse)");
        expect(rule).toContain("::before");
        expect(rule).toContain("::after");
    });
});
