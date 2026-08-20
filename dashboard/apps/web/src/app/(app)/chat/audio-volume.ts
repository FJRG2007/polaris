"use client";

/**
 * How loud the recordings in a conversation play.
 *
 * One level for all of them rather than one per message, which is the way
 * everybody expects it to work: somebody who turns a voice message down is
 * saying how loud this room should be, not making a decision about seven seconds
 * of speech. The next recording plays at the level they chose, and so does the
 * one tomorrow.
 *
 * Kept per browser, like the call volumes and the microphone settings: it is a
 * fact about a machine and the speakers plugged into it. A laptop on a desk and
 * the same account on a phone on a train want different answers, and neither is
 * the account's business.
 *
 * Deliberately not the call volumes next door. Those are per person and exist to
 * make one loud voice bearable in a room of six; this is one number for files
 * being played back on purpose.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "polaris.chat.audio-volume";

/** Same-tab announcement, since the storage event only reaches other tabs. */
const CHANGED = "polaris:chat-audio-volume";

/** Full, which is what an element does with no volume set on it. */
export const VOLUME_DEFAULT = 1;

function clamp(value: number): number {
    if (!Number.isFinite(value)) return VOLUME_DEFAULT;
    return Math.min(1, Math.max(0, value));
}

export function audioVolume(): number {
    if (typeof window === "undefined") return VOLUME_DEFAULT;
    try {
        const raw = window.localStorage.getItem(KEY);
        return raw === null ? VOLUME_DEFAULT : clamp(Number(raw));
    } catch {
        return VOLUME_DEFAULT;
    }
}

export function setAudioVolume(value: number): void {
    if (typeof window === "undefined") return;
    const level = clamp(value);
    try {
        if (level === VOLUME_DEFAULT) window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, String(level));
    } catch {
        // It still applies to what is playing; it just will not be remembered.
    }
    window.dispatchEvent(new Event(CHANGED));
}

/**
 * The level, and the way to change it.
 *
 * Every player in the room follows it at once - a level set on the message being
 * listened to and not on the one after it would be a setting nobody trusts. Read
 * after mount rather than during render: the server has no local storage, and a
 * slider that jumped after hydration would move under somebody's finger.
 */
export function useAudioVolume(): [number, (value: number) => void] {
    const [volume, setVolume] = useState(VOLUME_DEFAULT);

    useEffect(() => {
        const read = () => setVolume(audioVolume());
        read();
        window.addEventListener(CHANGED, read);
        window.addEventListener("storage", read);
        return () => {
            window.removeEventListener(CHANGED, read);
            window.removeEventListener("storage", read);
        };
    }, []);

    const choose = useCallback((value: number) => {
        setVolume(clamp(value));
        setAudioVolume(value);
    }, []);

    return [volume, choose];
}
