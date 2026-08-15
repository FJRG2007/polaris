/**
 * How much is done to a microphone when a call opens one.
 *
 * A ladder rather than a switch: off, the browser's own processors, and a model
 * on top of them. What is asserted here is the bottom two rungs, which are the
 * constraints handed to `getUserMedia` - the model is a graph and is tested by
 * whether it builds, not by what it returns.
 *
 * The case that matters most is "off". Leaving the three flags OUT rather than
 * setting them false would let the browser apply its own defaults, and the
 * setting would quietly do nothing - the failure that looks like it works.
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

const { applyMicCleanup, micCleanup, micConstraints, setMicCleanup } = await import(
    "@/app/(app)/chat/mic-cleanup"
);

const ALL_ON = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const ALL_OFF = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

beforeEach(() => {
    store.clear();
});

describe("the setting", () => {
    it("is the browser's own handling for somebody who has never touched it", () => {
        expect(micCleanup()).toBe("standard");
    });

    it("remembers each rung", () => {
        for (const level of ["off", "enhanced", "licensed", "standard"] as const) {
            setMicCleanup(level);
            expect(micCleanup()).toBe(level);
        }
    });

    it("stores nothing for the default, so it is not a value to migrate later", () => {
        setMicCleanup("enhanced");
        setMicCleanup("standard");
        expect(store.size).toBe(0);
    });

    it("treats anything else as unset", () => {
        // Local storage belongs to whoever owns the browser, and a filter chosen
        // by editing it is a filter nobody wrote.
        store.set("polaris.call.mic-cleanup", "krisp-please");
        expect(micCleanup()).toBe("standard");
    });
});

describe("what is asked of the microphone", () => {
    it("asks for all three at the standard setting", () => {
        expect(micConstraints()).toEqual(ALL_ON);
    });

    it("asks for all three under a model as well", () => {
        // A model works on what the browser hands it. Handing it the raw room
        // means handing it the echo of everybody else in the call.
        setMicCleanup("enhanced");
        expect(micConstraints()).toEqual(ALL_ON);
    });

    it("asks for none of them when off, rather than leaving them out", () => {
        setMicCleanup("off");
        expect(micConstraints()).toEqual(ALL_OFF);
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
        expect(applied).toEqual([ALL_ON]);
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
