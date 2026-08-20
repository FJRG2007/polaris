"use client";

/**
 * How loud this microphone goes out.
 *
 * The setting people reach for when they are told they are quiet. A headset
 * boom two inches from a mouth and a laptop lid three feet away are ten decibels
 * apart, and the browser's own gain control - which is on unless somebody turned
 * the cleanup off - only ever brings a level back towards the middle. It cannot
 * make a quiet microphone loud.
 *
 * Kept per browser, like the cleanup level and the volumes: it is a fact about a
 * room and a microphone, not about an account. One number for calls, voice
 * messages and clips, because it is one microphone - being told you are quiet on
 * a call and then recording a voice message at the same level would make the
 * setting worth nothing.
 *
 * Applied by `filterMic`, which is the one place a microphone is put through a
 * graph on its way out.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "polaris.mic.gain";

/** Same-tab announcement, since the storage event only reaches other tabs. */
const CHANGED = "polaris:mic-gain";

/** Untouched: exactly what the microphone hears, at the level it hears it. */
export const GAIN_DEFAULT = 1;

/**
 * How far it goes either way.
 *
 * Doubling is as far up as is honest: past that a quiet microphone is mostly
 * amplified room, and the limiter that follows would be doing all the work. Half
 * is as far down as is useful - anything quieter is a microphone that should be
 * muted instead.
 */
export const GAIN_MIN = 0.5;
export const GAIN_MAX = 2;

function clamp(value: number): number {
    if (!Number.isFinite(value)) return GAIN_DEFAULT;
    return Math.min(GAIN_MAX, Math.max(GAIN_MIN, value));
}

export function micGain(): number {
    if (typeof window === "undefined") return GAIN_DEFAULT;
    try {
        const raw = window.localStorage.getItem(KEY);
        // Local storage belongs to whoever owns the browser, so anything that is
        // not a number in range is treated as unset rather than trusted: this
        // one ends up multiplying somebody's voice.
        return raw === null ? GAIN_DEFAULT : clamp(Number(raw));
    } catch {
        return GAIN_DEFAULT;
    }
}

export function setMicGain(value: number): void {
    if (typeof window === "undefined") return;
    const level = clamp(value);
    try {
        if (level === GAIN_DEFAULT) window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, String(level));
    } catch {
        // It still applies to what is open now; it just will not be remembered.
    }
    window.dispatchEvent(new Event(CHANGED));
}

/** The setting, and the way to change it. Follows other tabs, so two windows of
 *  Polaris never disagree about how loud this machine is. */
export function useMicGain(): [number, (value: number) => void] {
    const [gain, setGain] = useState(GAIN_DEFAULT);

    useEffect(() => {
        const read = () => setGain(micGain());
        read();
        window.addEventListener(CHANGED, read);
        window.addEventListener("storage", read);
        return () => {
            window.removeEventListener(CHANGED, read);
            window.removeEventListener("storage", read);
        };
    }, []);

    const choose = useCallback((value: number) => {
        setGain(clamp(value));
        setMicGain(value);
    }, []);

    return [gain, choose];
}
