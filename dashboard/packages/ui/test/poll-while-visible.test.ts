// @vitest-environment jsdom

/**
 * A poll rests while its tab is hidden, reads once when the tab is looked at
 * again, and counts its next tick from that read rather than from before.
 */

import { pollWhileVisible } from "../src/lib/poll-while-visible";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let state: DocumentVisibilityState = "visible";

function show(next: DocumentVisibilityState): void {
    state = next;
    document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
    vi.useFakeTimers();
    state = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
});

afterEach(() => {
    vi.useRealTimers();
});

describe("pollWhileVisible", () => {
    it("reads on every tick while the tab is visible", () => {
        const read = vi.fn();
        const stop = pollWhileVisible(read, 1000);
        vi.advanceTimersByTime(3000);
        expect(read).toHaveBeenCalledTimes(3);
        stop();
    });

    it("asks nothing while hidden and reads once on return", () => {
        const read = vi.fn();
        const stop = pollWhileVisible(read, 1000);
        show("hidden");
        vi.advanceTimersByTime(5000);
        expect(read).not.toHaveBeenCalled();
        show("visible");
        expect(read).toHaveBeenCalledTimes(1);
        stop();
    });

    it("counts the next tick from the read on return", () => {
        const read = vi.fn();
        const stop = pollWhileVisible(read, 1000);
        show("hidden");
        vi.advanceTimersByTime(900);
        show("visible");
        expect(read).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(999);
        expect(read).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(read).toHaveBeenCalledTimes(2);
        stop();
    });

    it("stops ticking and listening once stopped", () => {
        const read = vi.fn();
        const stop = pollWhileVisible(read, 1000);
        stop();
        vi.advanceTimersByTime(5000);
        show("hidden");
        show("visible");
        expect(read).not.toHaveBeenCalled();
    });
});
