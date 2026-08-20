// @vitest-environment jsdom

/**
 * The two levels this machine remembers: how loud the microphone goes out, and
 * how loud recordings play back.
 *
 * Both are read out of local storage, which belongs to whoever owns the browser
 * - so both have to treat what they find there as a claim rather than a value.
 * One of them multiplies somebody's voice on the way into a room and the other
 * decides whether anything is heard at all; a stray string in either is a bug
 * nobody can see, only hear.
 *
 * The defaults matter as much: untouched has to mean untouched. A microphone
 * that quietly went out at anything other than the level it hears, or a
 * conversation that played back at anything other than full, would be Polaris
 * making a decision nobody asked it to make.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { audioVolume, setAudioVolume, VOLUME_DEFAULT } from "@/app/(app)/chat/audio-volume";
import { GAIN_DEFAULT, GAIN_MAX, GAIN_MIN, micGain, setMicGain } from "@/app/(app)/chat/mic-gain";

/**
 * A store to read and write.
 *
 * This runtime's jsdom has no local storage of its own - it says so on the way
 * in - so the thing being tested has to be given one. Written out rather than
 * mocked away: what these assert is exactly what happens between a value and
 * that store, and a mock of the store would be a test of the mock.
 */
beforeEach(() => {
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
});

describe("how loud the microphone goes out", () => {
    it("is untouched until somebody says otherwise", () => {
        expect(GAIN_DEFAULT).toBe(1);
        expect(micGain()).toBe(1);
    });

    it("remembers what was chosen", () => {
        setMicGain(1.5);
        expect(micGain()).toBe(1.5);
    });

    it("keeps the default out of storage, so an untouched machine stores nothing", () => {
        setMicGain(1.5);
        setMicGain(GAIN_DEFAULT);
        expect(window.localStorage.getItem("polaris.mic.gain")).toBeNull();
        expect(micGain()).toBe(1);
    });

    it("holds it inside what is honest either way", () => {
        // Past double, a quiet microphone is mostly amplified room; below half
        // it is a microphone that should be muted instead.
        setMicGain(9);
        expect(micGain()).toBe(GAIN_MAX);
        setMicGain(0);
        expect(micGain()).toBe(GAIN_MIN);
    });

    it("treats anything that is not a number as untouched", () => {
        window.localStorage.setItem("polaris.mic.gain", "loud");
        expect(micGain()).toBe(1);
    });
});

describe("how loud recordings play back", () => {
    it("is full until somebody turns it down", () => {
        expect(VOLUME_DEFAULT).toBe(1);
        expect(audioVolume()).toBe(1);
    });

    it("remembers a level, including silence", () => {
        setAudioVolume(0.4);
        expect(audioVolume()).toBe(0.4);
        setAudioVolume(0);
        expect(audioVolume()).toBe(0);
    });

    it("holds it between silent and full", () => {
        setAudioVolume(4);
        expect(audioVolume()).toBe(1);
        setAudioVolume(-2);
        expect(audioVolume()).toBe(0);
    });

    it("treats a stored non-number as full rather than as silence", () => {
        // The failure to avoid: a conversation that plays nothing at all, with
        // no way to tell that from a recording that will not load.
        window.localStorage.setItem("polaris.chat.audio-volume", "quiet");
        expect(audioVolume()).toBe(1);
    });
});
