// @vitest-environment jsdom
/**
 * The live microphone meter, in the call's microphone menu and on the devices
 * screen.
 *
 * What is pinned is what cannot be seen from the bars: given the call's own
 * microphone it measures a copy and never stops the original, and opening a
 * microphone of its own happens only where the browser already allowed it -
 * and is let go of when the meter goes away.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const measured: { stopped: boolean }[] = [];
vi.mock("@/app/(app)/chat/voice-level", () => ({
    measureVoice: () => {
        const meter = { stopped: false, read: () => 50, peak: () => 0.5, stop: () => undefined };
        meter.stop = () => void (meter.stopped = true);
        measured.push(meter);
        return meter;
    }
}));
vi.mock("@/app/(app)/chat/mic-cleanup", () => ({ micConstraints: () => ({}) }));

const { MicLevelMeter } = await import("@/app/(app)/chat/mic-level-meter");

function fakeTrack() {
    const track = {
        readyState: "live",
        enabled: false,
        stopped: false,
        clones: [] as ReturnType<typeof fakeTrack>[],
        stop: () => void (track.stopped = true),
        clone: () => {
            const copy = fakeTrack();
            track.clones.push(copy);
            return copy;
        }
    };
    return track;
}

function lit(): number {
    return screen.getByRole("meter").querySelectorAll("[data-lit]").length;
}

beforeEach(() => {
    vi.useFakeTimers();
    measured.length = 0;
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("the microphone meter", () => {
    it("lights bars from a track it is given, measuring a copy", () => {
        const track = fakeTrack();
        const { unmount } = render(<MicLevelMeter track={track as unknown as MediaStreamTrack} />);
        act(() => void vi.advanceTimersByTime(200));
        expect(lit()).toBeGreaterThan(0);
        // A copy, switched on, so a muted call still reads.
        expect(track.clones).toHaveLength(1);
        expect(track.clones[0]!.enabled).toBe(true);

        unmount();
        expect(track.clones[0]!.stopped).toBe(true);
        expect(measured[0]!.stopped).toBe(true);
        // The call's own microphone is never stopped by the meter.
        expect(track.stopped).toBe(false);
    });

    it("opens nothing where the browser has not been allowed the microphone", async () => {
        const getUserMedia = vi.fn();
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: { getUserMedia }
        });
        Object.defineProperty(navigator, "permissions", {
            configurable: true,
            value: { query: async () => ({ state: "prompt" }) }
        });
        render(<MicLevelMeter listen />);
        await act(async () => void (await vi.runOnlyPendingTimersAsync()));
        expect(getUserMedia).not.toHaveBeenCalled();
        expect(lit()).toBe(0);
    });

    it("opens its own where allowed, and lets go of it when it goes away", async () => {
        const own = fakeTrack();
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: {
                getUserMedia: async () => ({ getAudioTracks: () => [own], getTracks: () => [own] })
            }
        });
        Object.defineProperty(navigator, "permissions", {
            configurable: true,
            value: { query: async () => ({ state: "granted" }) }
        });
        const { unmount } = render(<MicLevelMeter listen deviceId="mic-1" />);
        await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
        expect(lit()).toBeGreaterThan(0);

        unmount();
        expect(own.stopped).toBe(true);
        expect(measured[0]!.stopped).toBe(true);
    });
});
