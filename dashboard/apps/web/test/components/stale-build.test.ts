/**
 * Telling "this tab is old" apart from "this page is broken".
 *
 * The whole value of the distinction is that one of them is reloaded from
 * silently and the other is shown to a human. Getting it wrong in either
 * direction is worse than not having it: a real fault answered with a refresh
 * disappears, and an old-build failure shown as an error is a Try again button
 * that can never work.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { isStaleBuildError, reloadForNewBuild } from "@/lib/stale-build";

describe("recognising an old build", () => {
    it("catches a server action from a build that is gone", () => {
        // Verbatim from the browser, which is the only form that matters.
        expect(
            isStaleBuildError(
                new Error('Server Action "60b910f57957f6a5a6e1681110456fbf2ef68f798e" was not found on the server.')
            )
        ).toBe(true);
        expect(isStaleBuildError(new Error("Failed to find Server Action \"abc\". This request might be from an older deployment."))).toBe(
            true
        );
    });

    it("catches a chunk the deploy replaced", () => {
        const chunk = new Error("Loading chunk 4821 failed.");
        chunk.name = "ChunkLoadError";
        expect(isStaleBuildError(chunk)).toBe(true);
        expect(isStaleBuildError(new Error("Loading CSS chunk 12 failed"))).toBe(true);
        expect(
            isStaleBuildError(new Error("Failed to fetch dynamically imported module: https://polaris.test/_next/x.js"))
        ).toBe(true);
    });

    it("leaves an ordinary failure alone", () => {
        // These reach a person. Reloading past them would hide the bug.
        expect(isStaleBuildError(new Error("Could not read the server"))).toBe(false);
        expect(isStaleBuildError(new Error("Server Action rejected: not permitted"))).toBe(false);
        expect(isStaleBuildError(new Error(""))).toBe(false);
        expect(isStaleBuildError(null)).toBe(false);
    });
});

describe("reloading for the new build", () => {
    const reload = vi.fn();

    beforeEach(() => {
        vi.stubGlobal("window", {
            sessionStorage: sessionStorageStub(),
            location: { reload }
        });
        reload.mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("reloads once and then stops, so it cannot loop", () => {
        expect(reloadForNewBuild()).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
        // The reload happened and the failure came back: that is no longer an old
        // tab, and the second call has to leave the message on screen.
        expect(reloadForNewBuild()).toBe(false);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("does not reload when it has nowhere to remember having tried", () => {
        vi.stubGlobal("window", {
            sessionStorage: {
                getItem: () => {
                    throw new Error("denied");
                },
                setItem: () => undefined
            },
            location: { reload }
        });
        expect(reloadForNewBuild()).toBe(false);
        expect(reload).not.toHaveBeenCalled();
    });
});

function sessionStorageStub() {
    const held = new Map<string, string>();
    return {
        getItem: (key: string) => held.get(key) ?? null,
        setItem: (key: string, value: string) => void held.set(key, value)
    };
}
