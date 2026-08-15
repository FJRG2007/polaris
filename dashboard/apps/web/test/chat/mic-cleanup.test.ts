/**
 * What is asked of a microphone when a call opens one.
 *
 * The three flags are the whole of the noise handling: they are the browser's
 * own echo canceller, noise suppressor and gain control, which cost nothing
 * because they are already running for every other call. Left unasked - which is
 * what `audio: true` does - what somebody gets depends on their browser's
 * defaults, and there is nothing for a person in a noisy room to turn on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.stubGlobal("window", {
    localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
    },
    dispatchEvent: () => true
});

const { applyMicCleanup, micCleanupOn, micConstraints, setMicCleanup } = await import(
    "@/app/(app)/chat/mic-cleanup"
);

beforeEach(() => {
    store.clear();
});

describe("the setting", () => {
    it("is on for somebody who has never touched it", () => {
        expect(micCleanupOn()).toBe(true);
    });

    it("is off once turned off, and on again after", () => {
        setMicCleanup(false);
        expect(micCleanupOn()).toBe(false);
        setMicCleanup(true);
        expect(micCleanupOn()).toBe(true);
    });

    it("stores nothing for the default, so it is not a value to migrate later", () => {
        setMicCleanup(false);
        setMicCleanup(true);
        expect(store.size).toBe(0);
    });
});

describe("what is asked of the microphone", () => {
    it("asks for all three", () => {
        expect(micConstraints()).toEqual({
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        });
    });

    it("asks for none of them once turned off, rather than leaving them out", () => {
        // Left out, the browser applies its own default and the setting does
        // nothing - which is the failure that looks like it works.
        setMicCleanup(false);
        expect(micConstraints()).toEqual({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
        });
    });

    it("keeps the chosen device beside them", () => {
        expect(micConstraints("mic-2")).toMatchObject({ deviceId: { exact: "mic-2" } });
    });
});

describe("applying it to a microphone already open", () => {
    it("changes the track rather than reopening the device", async () => {
        const applied: MediaTrackConstraints[] = [];
        await applyMicCleanup({
            applyConstraints: async (constraints: MediaTrackConstraints) => {
                applied.push(constraints);
            }
        } as unknown as MediaStreamTrack);
        expect(applied).toEqual([
            { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        ]);
    });

    it("says nothing when the device cannot do it", async () => {
        // Some interfaces and most virtual devices refuse. The audio keeps
        // flowing, and a call is not the place to explain that.
        await expect(
            applyMicCleanup({
                applyConstraints: async () => {
                    throw new Error("not supported");
                }
            } as unknown as MediaStreamTrack)
        ).resolves.toBeUndefined();
    });
});
