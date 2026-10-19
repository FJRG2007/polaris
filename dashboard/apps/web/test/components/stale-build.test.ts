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
import {
    CHUNK_RECOVERY_SCRIPT,
    isStaleBuildError,
    recoverMissingChunks,
    reloadForNewBuild
} from "@/lib/stale-build";

describe("recognising an old build", () => {
    it("catches a server action from a build that is gone", () => {
        // Verbatim from the browser, which is the only form that matters.
        expect(
            isStaleBuildError(
                new Error(
                    'Server Action "60b910f57957f6a5a6e1681110456fbf2ef68f798e" was not found on the server.'
                )
            )
        ).toBe(true);
        expect(
            isStaleBuildError(
                new Error(
                    'Failed to find Server Action "abc". This request might be from an older deployment.'
                )
            )
        ).toBe(true);
    });

    it("catches a chunk the deploy replaced", () => {
        const chunk = new Error("Loading chunk 4821 failed.");
        chunk.name = "ChunkLoadError";
        expect(isStaleBuildError(chunk)).toBe(true);
        expect(isStaleBuildError(new Error("Loading CSS chunk 12 failed"))).toBe(true);
        expect(
            isStaleBuildError(
                new Error(
                    "Failed to fetch dynamically imported module: https://polaris.test/_next/x.js"
                )
            )
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

describe("a page whose scripts never arrived", () => {
    const reload = vi.fn();
    let onError: ((event: { target: unknown }) => void) | null = null;
    const document = { readyState: "loading" };

    /** A load failure of one element, the way the capture listener sees it. */
    function fail(tagName: string, url: string, attribute: "src" | "href" = "src"): void {
        onError?.({ target: { tagName, [attribute]: url } });
    }

    /** Install the script the way the document does, on a fresh page. */
    function load(storage = sessionStorageStub()): void {
        onError = null;
        vi.stubGlobal("document", document);
        vi.stubGlobal("window", {
            sessionStorage: storage,
            location: { reload },
            addEventListener: (
                type: string,
                listener: (event: { target: unknown }) => void,
                capture: boolean
            ) => {
                // Load failures do not bubble: a listener outside the capture
                // phase would never hear one.
                if (type === "error" && capture === true) onError = listener;
            }
        });
        recoverMissingChunks();
    }

    beforeEach(() => {
        vi.useFakeTimers();
        reload.mockClear();
        document.readyState = "loading";
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("reloads once a chunk of the page fails while it is loading", () => {
        load();
        fail("SCRIPT", "https://polaris.test/_next/static/chunks/app/layout-1a2b.js");
        // A pause first: the rollover that caused it is seconds from ending.
        expect(reload).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1500);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("reloads for a stylesheet of the build, and only once for a burst", () => {
        load();
        fail("LINK", "https://polaris.test/_next/static/css/app-9f.css", "href");
        fail("SCRIPT", "https://polaris.test/_next/static/chunks/main-3c.js");
        vi.advanceTimersByTime(5000);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("leaves failures that are not the build's own files alone", () => {
        load();
        fail("IMG", "https://polaris.test/_next/static/media/logo.png");
        fail("SCRIPT", "https://cdn.example.test/widget.js");
        fail("SCRIPT", "");
        vi.advanceTimersByTime(5000);
        expect(reload).not.toHaveBeenCalled();
    });

    it("leaves a page that has finished loading to the new-build banner", () => {
        // Up and running, possibly with something typed into it: not ours to reload.
        load();
        document.readyState = "complete";
        fail("SCRIPT", "https://polaris.test/_next/static/chunks/4821.js");
        vi.advanceTimersByTime(5000);
        expect(reload).not.toHaveBeenCalled();
    });

    it("stops after three reloads in two minutes, so a missing file cannot loop", () => {
        const storage = sessionStorageStub();
        for (let attempt = 0; attempt < 4; attempt += 1) {
            load(storage);
            fail("SCRIPT", "https://polaris.test/_next/static/chunks/4821.js");
            vi.advanceTimersByTime(1500);
        }
        expect(reload).toHaveBeenCalledTimes(3);
        // Long after, a new rollover is a new story.
        vi.advanceTimersByTime(120_000);
        load(storage);
        fail("SCRIPT", "https://polaris.test/_next/static/chunks/4821.js");
        vi.advanceTimersByTime(1500);
        expect(reload).toHaveBeenCalledTimes(4);
    });

    it("does nothing when it has nowhere to count its attempts", () => {
        load({
            getItem: () => {
                throw new Error("denied");
            },
            setItem: () => undefined
        });
        fail("SCRIPT", "https://polaris.test/_next/static/chunks/4821.js");
        vi.advanceTimersByTime(5000);
        expect(reload).not.toHaveBeenCalled();
    });

    it("ships as a script that runs itself", () => {
        expect(CHUNK_RECOVERY_SCRIPT.startsWith("(")).toBe(true);
        expect(CHUNK_RECOVERY_SCRIPT.endsWith(")();")).toBe(true);
        expect(CHUNK_RECOVERY_SCRIPT).toContain("/_next/static/");
    });
});

function sessionStorageStub() {
    const held = new Map<string, string>();
    return {
        getItem: (key: string) => held.get(key) ?? null,
        setItem: (key: string, value: string) => void held.set(key, value)
    };
}
