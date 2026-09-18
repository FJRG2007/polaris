// @vitest-environment jsdom

/**
 * How loud Polaris' sounds are. Every tone - an alert, a message, a ring - is
 * scaled by the account's volume, a volume of zero plays nothing at all (a gain
 * ramp to zero throws), and anything unreadable is full volume, which is what
 * every account heard before this was a choice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asSoundVolume, DEFAULT_SOUND_VOLUME } from "@/lib/notifications/sound-volume";
import {
    adoptSoundVolume,
    onSoundVolumeChange,
    playNotificationSound,
    soundGain,
    soundVolume
} from "@/lib/notification-sound";
import { playCallSound, SOUNDS, DEFAULT_GAIN } from "@/lib/call-sounds";

const store = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
    }
});

/** Every peak a tone was ramped up to, and how many contexts were made. */
let peaks: number[] = [];
let contexts = 0;

class FakeContext {
    state = "running";
    currentTime = 0;
    destination = {};
    constructor() {
        contexts += 1;
    }
    resume() {
        return Promise.resolve();
    }
    createOscillator() {
        return {
            type: "sine",
            frequency: {
                value: 0,
                setValueAtTime: () => undefined,
                linearRampToValueAtTime: () => undefined
            },
            connect: (node: unknown) => node,
            start: () => undefined,
            stop: () => undefined
        };
    }
    createGain() {
        const node = {
            gain: {
                setValueAtTime: () => undefined,
                linearRampToValueAtTime: (value: number) => void peaks.push(value),
                exponentialRampToValueAtTime: (value: number) => {
                    if (value > 0.001) peaks.push(value);
                }
            },
            connect: (next: unknown) => next
        };
        return node;
    }
}

beforeEach(() => {
    peaks = [];
    contexts = 0;
    vi.stubGlobal("AudioContext", FakeContext);
    Object.assign(window, { AudioContext: FakeContext });
});

afterEach(() => {
    adoptSoundVolume(DEFAULT_SOUND_VOLUME);
    vi.unstubAllGlobals();
});

describe("asSoundVolume", () => {
    it("keeps a percentage and turns anything else into full volume", () => {
        expect(asSoundVolume(40)).toBe(40);
        expect(asSoundVolume(0)).toBe(0);
        expect(asSoundVolume(undefined)).toBe(DEFAULT_SOUND_VOLUME);
        expect(asSoundVolume(101)).toBe(DEFAULT_SOUND_VOLUME);
        expect(asSoundVolume(12.5)).toBe(DEFAULT_SOUND_VOLUME);
        expect(asSoundVolume("50")).toBe(DEFAULT_SOUND_VOLUME);
        expect(DEFAULT_SOUND_VOLUME).toBe(100);
    });
});

describe("the volume", () => {
    it("scales the message sound", () => {
        adoptSoundVolume(100);
        playCallSound("message");
        const full = [...peaks];
        expect(full[0]).toBeCloseTo(SOUNDS.message[0]!.gain ?? DEFAULT_GAIN);

        peaks = [];
        adoptSoundVolume(50);
        expect(soundGain()).toBe(0.5);
        playCallSound("message");
        expect(peaks[0]).toBeCloseTo(full[0]! / 2);
    });

    it("scales the notification chime", async () => {
        adoptSoundVolume(100);
        playNotificationSound();
        const full = peaks[0]!;
        peaks = [];
        adoptSoundVolume(25);
        playNotificationSound();
        expect(peaks[0]).toBeCloseTo(full / 4);
    });

    it("plays nothing at zero", () => {
        adoptSoundVolume(0);
        playCallSound("ring");
        playNotificationSound();
        expect(peaks).toEqual([]);
    });

    it("is kept under the account it belongs to", () => {
        // Two accounts signed in side by side share one browser store, and a
        // volume written under one key would be adopted by the other.
        adoptSoundVolume(45, "ada");
        expect(store.get("polaris.notifications.volume.ada")).toBe("45");

        const heard = vi.fn();
        const stop = onSoundVolumeChange(heard);
        window.dispatchEvent(
            new StorageEvent("storage", {
                key: "polaris.notifications.volume.grace",
                newValue: "10"
            })
        );
        expect(soundVolume()).toBe(45);
        expect(heard).not.toHaveBeenCalled();
        stop();
        adoptSoundVolume(DEFAULT_SOUND_VOLUME, "");
    });

    it("is shared with the other tabs, and follows theirs", () => {
        adoptSoundVolume(30);
        expect(store.get("polaris.notifications.volume")).toBe("30");
        expect(soundVolume()).toBe(30);

        const heard = vi.fn();
        const stop = onSoundVolumeChange(heard);
        window.dispatchEvent(
            new StorageEvent("storage", { key: "polaris.notifications.volume", newValue: "70" })
        );
        expect(soundVolume()).toBe(70);
        expect(heard).toHaveBeenCalledTimes(1);
        // Something that is not a volume is not taken.
        window.dispatchEvent(
            new StorageEvent("storage", { key: "polaris.notifications.volume", newValue: "loud" })
        );
        expect(soundVolume()).toBe(70);
        stop();
    });
});
