"use client";

/**
 * How much is done to what the microphone hears, before it leaves the browser.
 *
 * Four settings, and they are a ladder rather than a set of switches:
 *
 *   off      - exactly what the microphone hears. For somebody playing an
 *              instrument, where a canceller is the thing ruining the recording.
 *   standard - the browser's own echo canceller, noise suppressor and gain
 *              control. Free, already compiled into the browser, already using
 *              the hardware canceller where the machine has one, and enough for
 *              a fan or a hiss.
 *   enhanced - a model, on top of that: see `mic-filter`. This is what removes a
 *              keyboard, a dog, and the conversation at the next desk, which no
 *              amount of signal processing will.
 *   licensed - a filter an administrator connected, when there is one.
 *
 * Standard is the default because it costs nothing and suits most rooms;
 * enhanced is one press away and fetches its model then, not before.
 *
 * Kept per browser, like the volumes: it is a fact about a room and a
 * microphone, not about an account. The three constraints apply to the live
 * track through `applyConstraints`, so changing the setting never renegotiates.
 */

import { micDevice } from "./mic-device";
import type { MicFilter } from "./mic-filter";
import { useCallback, useEffect, useState } from "react";

const KEY = "polaris.call.mic-cleanup";

/** What somebody who has never touched it gets. */
export const CLEANUP_DEFAULT: MicFilter = "standard";

/** Same-tab announcement, since the storage event only reaches other tabs. */
const CHANGED = "polaris:call-mic-cleanup";

const LEVELS: readonly MicFilter[] = ["off", "standard", "enhanced", "licensed"];

export function micCleanup(): MicFilter {
    if (typeof window === "undefined") return CLEANUP_DEFAULT;
    try {
        const raw = window.localStorage.getItem(KEY);
        // Local storage is editable by whoever owns the browser, so anything
        // that is not one of the four is treated as unset.
        return LEVELS.includes(raw as MicFilter) ? (raw as MicFilter) : CLEANUP_DEFAULT;
    } catch {
        return CLEANUP_DEFAULT;
    }
}

export function setMicCleanup(level: MicFilter): void {
    if (typeof window === "undefined") return;
    try {
        if (level === CLEANUP_DEFAULT) window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, level);
    } catch {
        // It still applies to this call; it just will not be remembered.
    }
    window.dispatchEvent(new Event(CHANGED));
}

/** Whether the browser's own processors are wanted. On for everything except
 *  "off": a model works on what the browser hands it, and handing it the raw
 *  room means handing it the echo too. */
function browserProcessing(level: MicFilter): boolean {
    return level !== "off";
}

/**
 * What to ask the browser for when opening a microphone.
 *
 * With no device named it asks for the one this browser has been told to use -
 * so a microphone picked in a call is the one a voice message is recorded
 * through, and the other way round. Naming one explicitly is how that choice is
 * made in the first place.
 *
 * The two are asked for differently on purpose. A device somebody has just picked
 * is `exact`, because quietly opening a different microphone than the one they
 * chose is worse than telling them it could not be opened. The remembered one is
 * `ideal`: it names a headset that may have been unplugged three days ago, and
 * that must never be the reason a recording cannot start.
 */
export function micConstraints(deviceId?: string): MediaTrackConstraints {
    const on = browserProcessing(micCleanup());
    const remembered = micDevice();
    return {
        ...(deviceId
            ? { deviceId: { exact: deviceId } }
            : remembered
              ? { deviceId: { ideal: remembered } }
              : {}),
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
    const on = browserProcessing(micCleanup());
    await track
        .applyConstraints({ echoCancellation: on, noiseSuppression: on, autoGainControl: on })
        .catch(() => undefined);
}

/** The setting, and a way to change it. */
export function useMicCleanup(): [MicFilter, (level: MicFilter) => void] {
    const [level, setLevel] = useState<MicFilter>(CLEANUP_DEFAULT);

    // After mount, never during render: the server has no local storage, and a
    // value read while rendering would not match what it sent.
    useEffect(() => {
        setLevel(micCleanup());
        const onChange = () => setLevel(micCleanup());
        window.addEventListener(CHANGED, onChange);
        window.addEventListener("storage", onChange);
        return () => {
            window.removeEventListener(CHANGED, onChange);
            window.removeEventListener("storage", onChange);
        };
    }, []);

    const change = useCallback((next: MicFilter) => {
        setLevel(next);
        setMicCleanup(next);
    }, []);

    return [level, change];
}
