// @vitest-environment jsdom

/**
 * Telling the quiet person that they are quiet.
 *
 * Reported as one person in a call heard very quietly by everybody, who could
 * not tell from their own end. What is pinned: the hint appears once their
 * outgoing voice has sat well below everybody else's for long enough, not
 * before; its button turns the microphone volume up; and it says nothing while
 * the microphone is off.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useQuietMic } from "@/app/(app)/chat/quiet-mic-notice";
import { micGain } from "@/app/(app)/chat/mic-gain";
import { ENOUGH_SPEECH_MS, SELF, setLoudness, type Loudness } from "@/app/(app)/chat/call-loudness";

function voice(db: number, ms = ENOUGH_SPEECH_MS + 1000): Loudness {
    return { speechDb: db, speechMs: ms };
}

/** This environment's storage is not a usable one, so each case gets its own. */
const kept = new Map<string, string>();
beforeEach(() => {
    kept.clear();
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => kept.get(key) ?? null,
            setItem: (key: string, value: string) => void kept.set(key, value),
            removeItem: (key: string) => void kept.delete(key)
        }
    });
});

afterEach(() => {
    cleanup();
    act(() => setLoudness(new Map()));
});

describe("the quiet hint", () => {
    it("waits until both sides have been heard for long enough", () => {
        const { result } = renderHook(() => useQuietMic(true));
        act(() =>
            setLoudness(
                new Map([
                    [SELF, voice(-45, 3000)],
                    ["ana", voice(-26)]
                ])
            )
        );
        expect(result.current.quiet).toBe(false);
    });

    it("appears when you sit well below the room, and turns you up", () => {
        const { result } = renderHook(() => useQuietMic(true));
        act(() =>
            setLoudness(
                new Map([
                    [SELF, voice(-42)],
                    ["ana", voice(-26)],
                    ["luis", voice(-28)]
                ])
            )
        );
        expect(result.current.quiet).toBe(true);
        expect(micGain()).toBe(1);
        act(() => result.current.turnUp());
        expect(micGain()).toBe(1.25);
    });

    it("says nothing for a voice that is merely a little quieter", () => {
        const { result } = renderHook(() => useQuietMic(true));
        act(() =>
            setLoudness(
                new Map([
                    [SELF, voice(-31)],
                    ["ana", voice(-26)]
                ])
            )
        );
        expect(result.current.quiet).toBe(false);
    });

    it("says nothing while the microphone is off", () => {
        const { result } = renderHook(() => useQuietMic(false));
        act(() =>
            setLoudness(
                new Map([
                    [SELF, voice(-50)],
                    ["ana", voice(-26)]
                ])
            )
        );
        expect(result.current.quiet).toBe(false);
    });
});
