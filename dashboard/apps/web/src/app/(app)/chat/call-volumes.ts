"use client";

/**
 * How loud each person is, for this reader and this browser.
 *
 * Kept in local storage rather than on the server, and that is the right place
 * for it: "this person is always too loud on my laptop speakers" is a fact about
 * a pair of ears and a set of speakers, not about the person - the same account
 * on a headset wants a different answer, and nobody else in the call has any
 * business knowing.
 *
 * Keyed by account rather than by the participant row, so turning somebody down
 * holds across calls. A guest has no account, so their setting lasts as long as
 * their seat does, which is the most that can honestly be offered.
 *
 * Applied to the audio element, never to the connection: the sound still arrives
 * and is simply played quieter, so a change is instant and nobody is
 * renegotiated at.
 */

import { useCallback, useEffect, useState } from "react";

const PREFIX = "polaris.call.volume.";

/** Everything above 1 is amplification the element does not do, so this is the
 *  whole range: silent to as sent. */
export const MAX_VOLUME = 1;

/** What somebody nobody has adjusted is played at. */
export const DEFAULT_VOLUME = 1;

/** The browser event this module fires at itself, so two call screens open in
 *  one tab agree without either of them polling. The storage event covers other
 *  tabs and deliberately does not fire in the one that wrote. */
const CHANGED = "polaris:call-volume";

function keyFor(personId: string): string {
    return `${PREFIX}${personId}`;
}

/** The stored volume for one person, or the default. */
export function volumeFor(personId: string): number {
    if (typeof window === "undefined") return DEFAULT_VOLUME;
    try {
        const raw = window.localStorage.getItem(keyFor(personId));
        if (raw === null) return DEFAULT_VOLUME;
        const value = Number.parseFloat(raw);
        // A stored value that is not a number, or is out of range, is treated as
        // absent. Local storage is editable by whoever owns the browser, and a
        // NaN reaching `element.volume` throws.
        if (!Number.isFinite(value)) return DEFAULT_VOLUME;
        return Math.min(MAX_VOLUME, Math.max(0, value));
    } catch {
        // Storage refused - a browser with it disabled, or a full quota.
        return DEFAULT_VOLUME;
    }
}

export function setVolumeFor(personId: string, volume: number): void {
    if (typeof window === "undefined") return;
    const clamped = Math.min(MAX_VOLUME, Math.max(0, volume));
    try {
        if (clamped === DEFAULT_VOLUME) window.localStorage.removeItem(keyFor(personId));
        else window.localStorage.setItem(keyFor(personId), String(clamped));
    } catch {
        // Nothing to say: the volume still applies for this call, it just will
        // not be remembered.
    }
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: personId }));
}

/**
 * The volume for one person, and a way to change it.
 *
 * @param personId - Their account id where they have one, and their participant
 *   id where they do not.
 */
export function useCallVolume(personId: string): [number, (volume: number) => void] {
    const [volume, setVolume] = useState(DEFAULT_VOLUME);

    // Read after mount rather than as the initial state: the server has no local
    // storage, and a value read during render would not match what it sent.
    useEffect(() => {
        setVolume(volumeFor(personId));
        const onChange = () => setVolume(volumeFor(personId));
        window.addEventListener(CHANGED, onChange);
        window.addEventListener("storage", onChange);
        return () => {
            window.removeEventListener(CHANGED, onChange);
            window.removeEventListener("storage", onChange);
        };
    }, [personId]);

    const change = useCallback(
        (next: number) => {
            setVolume(Math.min(MAX_VOLUME, Math.max(0, next)));
            setVolumeFor(personId, next);
        },
        [personId]
    );

    return [volume, change];
}
