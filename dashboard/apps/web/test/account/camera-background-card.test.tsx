// @vitest-environment jsdom

/**
 * Testing a background from the Voice & Video screen.
 *
 * Two things are worth pinning, and both are about not doing something. A call
 * already holds the camera and already has the background drawn on it, so the
 * preview shows that picture rather than opening the device a second time and
 * running a second model on it - some machines will not open a camera twice at
 * all, and the ones that will would be segmenting the same room in two places.
 *
 * And when there is no call, the preview is the only place a background can be
 * checked, so changing the setting has to redraw it - a preview that kept
 * showing the old one would be a screen that lies about the thing it exists to
 * answer.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraBackground } from "@/app/(app)/chat/camera-background";

/** Every background the card asked for, and whether it was let go of. */
const asked: { using: CameraBackground; stopped: boolean }[] = [];

vi.mock("@/app/(app)/chat/camera-filter", () => ({
    maskCamera: async (_track: MediaStreamTrack, background: CameraBackground) => {
        if (background === "off") return null;
        const built = {
            track: { id: `masked-${background}`, stop: () => undefined },
            using: background,
            problem: null,
            stopped: false,
            stop: async () => void (built.stopped = true)
        };
        asked.push(built as unknown as (typeof asked)[number]);
        return built;
    }
}));

/** The meter opens microphones of its own, which is not what is being tested. */
vi.mock("@/app/(app)/chat/mic-level-meter", () => ({ MicLevelMeter: () => null }));

let call: { session: boolean; track: unknown } | null = null;
vi.mock("@/app/(app)/chat/call-hold", () => ({
    useHeldCall: () =>
        call
            ? {
                  session: call.session,
                  call: {
                      localStream: {
                          getVideoTracks: () => (call?.track ? [call.track] : []),
                          // The microphone card reads the same stream.
                          getAudioTracks: () => []
                      }
                  }
              }
            : null
}));

const { DevicesView } = await import("@/app/(app)/account/devices/devices-view");
const { setCameraBackground } = await import("@/app/(app)/chat/camera-background");

const opened: unknown[] = [];

function fakeTrack(id: string) {
    return { id, readyState: "live", enabled: true, stop: () => undefined };
}

beforeEach(() => {
    asked.length = 0;
    opened.length = 0;
    call = null;
    // jsdom here hands out no local storage, and every setting on this screen
    // is kept in it.
    const kept = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => kept.get(key) ?? null,
            setItem: (key: string, value: string) => void kept.set(key, value),
            removeItem: (key: string) => void kept.delete(key),
            clear: () => kept.clear()
        }
    });
    class FakeStream {
        constructor(readonly tracks: unknown[] = []) {}
        getTracks() {
            return this.tracks;
        }
        getVideoTracks() {
            return this.tracks;
        }
        getAudioTracks() {
            return [];
        }
    }
    vi.stubGlobal("MediaStream", FakeStream);
    HTMLMediaElement.prototype.play = async () => undefined;
    Object.defineProperty(navigator, "permissions", {
        configurable: true,
        value: { query: async () => ({ state: "prompt" }) }
    });
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
            enumerateDevices: async () => [],
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            getUserMedia: async () => {
                const track = fakeTrack("device");
                opened.push(track);
                return new FakeStream([track]);
            }
        }
    });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

/** The camera card's own button, which the microphone's "Test it" is not. */
function showMe(): HTMLElement {
    return screen.getByRole("button", { name: "Show me" });
}

describe("the camera preview", () => {
    it("shows the call's own picture rather than opening a second camera", async () => {
        setCameraBackground("blur");
        call = { session: true, track: fakeTrack("the-call") };
        render(<DevicesView />);

        await act(async () => void showMe().click());

        // Neither the device nor a second model: the call is holding both.
        expect(opened).toHaveLength(0);
        expect(asked).toHaveLength(0);
    });

    it("draws the background it is given, and draws the next one when it changes", async () => {
        setCameraBackground("blur");
        render(<DevicesView />);

        await act(async () => void showMe().click());
        expect(opened).toHaveLength(1);
        expect(asked.map((entry) => entry.using)).toEqual(["blur"]);

        await act(async () => void setCameraBackground("strong"));
        expect(asked.map((entry) => entry.using)).toEqual(["blur", "strong"]);
        // The one it replaced is let go of rather than left running beside it.
        expect(asked[0]?.stopped).toBe(true);
        expect(asked[1]?.stopped).toBe(false);
    });

    it("builds nothing at all for a camera nobody asked to change", async () => {
        render(<DevicesView />);
        await act(async () => void showMe().click());
        expect(opened).toHaveLength(1);
        expect(asked).toHaveLength(0);
    });
});
