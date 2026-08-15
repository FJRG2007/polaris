"use client";

/**
 * Cleaning up what the microphone hears, before it leaves the browser.
 *
 * Three processors, all of them in the browser already and all of them free:
 * echo cancellation (so the room does not hear itself through your speakers),
 * noise suppression (the fan, the street, the keyboard) and automatic gain
 * (somebody far from their microphone stays audible). Asked for explicitly
 * rather than left to the browser's defaults, because a default is not a
 * setting: it cannot be turned off for the person recording a guitar, and it
 * differs between browsers.
 *
 * Deliberately no model and no worklet. The two things a call client can add on
 * top are Krisp, which is proprietary and licensed per seat, and RNNoise, which
 * is free but means shipping a WebAssembly build and running it over every
 * 10 ms of audio on the sending side. What is here costs nothing measurable: it
 * is the same code the browser runs for every other call, already compiled into
 * it, already using the hardware canceller where the machine has one.
 *
 * Kept per browser, like the volumes: it is a fact about a room and a
 * microphone, not about an account. Turning it off applies to the live track
 * through `applyConstraints`, so nobody is renegotiated at and the call does not
 * pause while it happens.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "polaris.call.mic-cleanup";

/** On, because the overwhelming majority of calls are somebody in a room with a
 *  laptop, and the one case it is wrong for is the one somebody knows to go and
 *  turn off. */
export const CLEANUP_DEFAULT = true;

/** Same-tab announcement, since the storage event only reaches other tabs. */
const CHANGED = "polaris:call-mic-cleanup";

export function micCleanupOn(): boolean {
    if (typeof window === "undefined") return CLEANUP_DEFAULT;
    try {
        const raw = window.localStorage.getItem(KEY);
        return raw === null ? CLEANUP_DEFAULT : raw === "on";
    } catch {
        return CLEANUP_DEFAULT;
    }
}

export function setMicCleanup(on: boolean): void {
    if (typeof window === "undefined") return;
    try {
        if (on === CLEANUP_DEFAULT) window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
        // It still applies to this call; it just will not be remembered.
    }
    window.dispatchEvent(new Event(CHANGED));
}

/** What to ask the browser for when opening a microphone. */
export function micConstraints(deviceId?: string): MediaTrackConstraints {
    const on = micCleanupOn();
    return {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: on,
        noiseSuppression: on,
        autoGainControl: on
    };
}

/**
 * Apply the setting to a microphone that is already open.
 *
 * A failure is ignored on purpose: `applyConstraints` rejects on inputs that
 * cannot do these things at all - some external interfaces, and most virtual
 * devices - and a call is not the place to explain that. The audio keeps
 * flowing either way, which is what matters.
 */
export async function applyMicCleanup(track: MediaStreamTrack | null): Promise<void> {
    if (!track) return;
    const on = micCleanupOn();
    await track
        .applyConstraints({ echoCancellation: on, noiseSuppression: on, autoGainControl: on })
        .catch(() => undefined);
}

/** The setting, and a way to change it. */
export function useMicCleanup(): [boolean, (on: boolean) => void] {
    const [on, setOn] = useState(CLEANUP_DEFAULT);

    // After mount, never during render: the server has no local storage, and a
    // value read while rendering would not match what it sent.
    useEffect(() => {
        setOn(micCleanupOn());
        const onChange = () => setOn(micCleanupOn());
        window.addEventListener(CHANGED, onChange);
        window.addEventListener("storage", onChange);
        return () => {
            window.removeEventListener(CHANGED, onChange);
            window.removeEventListener("storage", onChange);
        };
    }, []);

    const change = useCallback((next: boolean) => {
        setOn(next);
        setMicCleanup(next);
    }, []);

    return [on, change];
}
