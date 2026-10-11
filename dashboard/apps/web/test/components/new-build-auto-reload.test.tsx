// @vitest-environment jsdom

/**
 * A tab taking an update by itself.
 *
 * Pinned: it reloads only when that costs nothing - in the background, after a
 * while untouched - and never in
 * a call, while something is in progress, twice in a row, or before a new build
 * has actually been seen.
 */

import { withMessages } from "../setup/i18n";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let ready = true;
vi.mock("@/lib/new-build", () => ({
    checkForNewBuild: async () => ready,
    newBuildReady: () => ready,
    rememberServedBuild: () => undefined,
    subscribeToBuild: () => () => undefined,
    watchForStaleFailures: () => () => undefined
}));
let held: { session: object | null } | null = null;
vi.mock("@/app/(app)/chat/call-hold", () => ({ useHeldCall: () => held }));
vi.mock("@/app/(app)/chat/call-resume", () => ({ rememberCall: () => undefined }));
let safe = true;
const reloadNow = vi.fn();
vi.mock("@/lib/reload-safety", () => ({ safeToReload: () => safe, reloadNow }));

const { NewBuildBanner } = await import("@/components/new-build-banner");

let visibility: DocumentVisibilityState = "visible";

function goToBackground(): void {
    visibility = "hidden";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
}

beforeEach(() => {
    ready = true;
    held = null;
    safe = true;
    visibility = "visible";
    reloadNow.mockClear();
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}"))
    );
    const kept = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key)
    });
    vi.useFakeTimers();
});
afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("taking an update by itself", () => {
    it("reloads when the tab goes to the background", () => {
        render(withMessages(<NewBuildBanner served="b1" />));
        expect(reloadNow).not.toHaveBeenCalled();
        goToBackground();
        expect(reloadNow).toHaveBeenCalledTimes(1);
    });

    it("reloads after a while untouched, and a touch starts the wait again", () => {
        render(withMessages(<NewBuildBanner served="b1" />));
        act(() => void vi.advanceTimersByTime(90_000));
        act(() => void window.dispatchEvent(new Event("keydown")));
        act(() => void vi.advanceTimersByTime(90_000));
        expect(reloadNow).not.toHaveBeenCalled();
        act(() => void vi.advanceTimersByTime(60_000));
        expect(reloadNow).toHaveBeenCalledTimes(1);
    });

    it("never interrupts a call", () => {
        held = { session: { meetingId: "m1" } };
        render(withMessages(<NewBuildBanner served="b1" />));
        goToBackground();
        act(() => void vi.advanceTimersByTime(10 * 60_000));
        expect(reloadNow).not.toHaveBeenCalled();
    });

    it("waits while something is in progress", () => {
        safe = false;
        render(withMessages(<NewBuildBanner served="b1" />));
        goToBackground();
        act(() => void vi.advanceTimersByTime(10 * 60_000));
        expect(reloadNow).not.toHaveBeenCalled();
    });

    it("takes one automatic reload per cooldown, so a rollover cannot loop it", () => {
        const first = render(withMessages(<NewBuildBanner served="b1" />));
        goToBackground();
        first.unmount();
        visibility = "visible";
        render(withMessages(<NewBuildBanner served="b1" />));
        goToBackground();
        expect(reloadNow).toHaveBeenCalledTimes(1);
    });

    it("does nothing until a new build has been seen", () => {
        ready = false;
        render(withMessages(<NewBuildBanner served="b1" />));
        goToBackground();
        act(() => void vi.advanceTimersByTime(10 * 60_000));
        expect(reloadNow).not.toHaveBeenCalled();
    });
});
