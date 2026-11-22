// @vitest-environment jsdom

/**
 * When a reload would cost somebody something.
 *
 * Pinned: a hold, an unsaved field, a transfer under way and media playing
 * each make it unsafe; focus alone does not; buttons and checkboxes do not, and asking never runs the
 * page's own unload listeners.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

let underWay = false;
vi.mock("@/components/transfers/transfer-store", () => ({
    transfersNow: () => (underWay ? [{ id: "t1" }] : []),
    isUnderWay: () => underWay
}));

const { holdReload, restoreAfterReload, safeToReload } = await import("@/lib/reload-safety");
const work = await import("@/lib/work-in-progress");

// What the shell does on every page.
restoreAfterReload();

afterEach(() => {
    underWay = false;
    document.body.innerHTML = "";
    window.sessionStorage.clear();
    work.resetWorkInProgress();
    vi.useRealTimers();
});

describe("whether the tab can reload by itself", () => {
    it("is safe on a quiet page", () => {
        expect(safeToReload()).toBe(true);
    });

    it("waits while something holds it, and releasing twice counts once", () => {
        const release = holdReload();
        const other = holdReload();
        expect(safeToReload()).toBe(false);
        release();
        release();
        expect(safeToReload()).toBe(false);
        other();
        expect(safeToReload()).toBe(true);
    });

    it("waits for an unsaved field, but not for focus alone", () => {
        const field = document.createElement("textarea");
        const button = document.createElement("button");
        document.body.append(field, button);
        field.focus();
        expect(safeToReload()).toBe(true);
        field.value = "half a sentence";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        button.focus();
        expect(safeToReload()).toBe(false);
    });

    it("waits while a file is moving", () => {
        underWay = true;
        expect(safeToReload()).toBe(false);
    });

    it("waits while a video or sound is playing", () => {
        const video = document.createElement("video");
        document.body.append(video);
        Object.defineProperty(video, "paused", { configurable: true, value: false });
        expect(safeToReload()).toBe(false);
        Object.defineProperty(video, "paused", { configurable: true, value: true });
        expect(safeToReload()).toBe(true);
    });

    it("never fires the page's unload listeners to ask", () => {
        const leave = vi.fn();
        window.addEventListener("beforeunload", leave);
        expect(safeToReload()).toBe(true);
        expect(leave).not.toHaveBeenCalled();
        window.removeEventListener("beforeunload", leave);
    });
});
