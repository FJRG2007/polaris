// @vitest-environment jsdom

/**
 * Nothing moves while nobody can be looking.
 *
 * The desktop app keeps drawing a minimized window, so the page itself has to
 * notice: hidden, or its window blurred, puts `data-idle` on `<html>` (which
 * pauses the CSS loops) and stops the script loops that ask to be stopped.
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

describe("the idle mark", () => {
    it("reads hidden or unfocused as idle", () => {
        expect(readIdle()).toBe(false);
        focused = false;
        expect(readIdle()).toBe(true);
        focused = true;
        visibility = "hidden";
        expect(readIdle()).toBe(true);
    });

    it("follows the window's focus", () => {
        const stop = watchIdle();
        expect(marked()).toBe(false);
        blur();
        expect(marked()).toBe(true);
        expect(isIdle()).toBe(true);
        focus();
        expect(marked()).toBe(false);
        stop();
    });

    it("follows the document's visibility", () => {
        const stop = watchIdle();
        visibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
        expect(marked()).toBe(true);
        visibility = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
        expect(marked()).toBe(false);
        stop();
    });

    it("stays awake when focus only moved into a frame of the page", () => {
        const stop = watchIdle();
        window.dispatchEvent(new Event("blur"));
        vi.advanceTimersByTime(1);
        expect(marked()).toBe(false);
        stop();
    });

    it("starts idle in a window opened in the background", () => {
        focused = false;
        const stop = watchIdle();
        expect(marked()).toBe(true);
        stop();
        expect(marked()).toBe(false);
    });

    it("is removed only when the last watcher stops", () => {
        const first = watchIdle();
        const second = watchIdle();
        blur();
        first();
        expect(marked()).toBe(true);
        second();
        expect(marked()).toBe(false);
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
        const atBlur = frame.mock.calls.length;
        vi.advanceTimersByTime(500);
        expect(frame.mock.calls.length).toBe(atBlur);

        focus();
        vi.advanceTimersByTime(100);
        expect(frame.mock.calls.length).toBeGreaterThan(atBlur);

        stop();
        const atStop = frame.mock.calls.length;
        vi.advanceTimersByTime(500);
        expect(frame.mock.calls.length).toBe(atStop);
    });

    it("never starts in a window that is already idle", () => {
        focused = false;
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
