"use client";

/**
 * The sound of a shared screen, and what the viewer does with it.
 *
 * A stream's sound is played only while it is being watched - on the stage, or
 * popped out into its own window - which is what every voice client does: a
 * share somebody has not opened is not something they asked to hear. The room
 * draws the picture and knows what is watched; the call's audio is mounted
 * elsewhere and plays it, so the two meet here, in a small store both read.
 *
 * Volume and mute are per sharer and per browser, like everybody's voice
 * volume, and kept apart from it: turning a friend's film down is not turning
 * the friend down.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/** Where a stream's volume is remembered, beside the voices in `call-volumes`. */
export function streamVolumeKey(person: string): string {
    return `stream:${person}`;
}

// ---------------------------------------------------------------------------
// What is being watched
// ---------------------------------------------------------------------------

const EMPTY: readonly string[] = [];
let watchedKeys: readonly string[] = EMPTY;
let popped: { key: string; video: HTMLVideoElement } | null = null;
const listeners = new Set<() => void>();

function changed(): void {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Said by the room whenever what is on its stage changes. Left as it was when
 *  the room closes, so a stream being watched keeps playing while somebody
 *  reads another conversation. */
export function setWatchedStreams(keys: readonly string[]): void {
    if (keys.length === watchedKeys.length && keys.every((key, at) => watchedKeys[at] === key)) {
        return;
    }
    watchedKeys = keys.length === 0 ? EMPTY : [...keys];
    changed();
}

/** Every stream key being watched, on the stage or popped out. */
export function watchedStreams(): readonly string[] {
    if (!popped || watchedKeys.includes(popped.key)) return watchedKeys;
    return [...watchedKeys, popped.key];
}

let snapshot: readonly string[] = EMPTY;
function currentWatched(): readonly string[] {
    const next = watchedStreams();
    if (next.length !== snapshot.length || next.some((key, at) => snapshot[at] !== key)) {
        snapshot = next;
    }
    return snapshot;
}

export function useWatchedStreams(): readonly string[] {
    return useSyncExternalStore(subscribe, currentWatched, () => EMPTY);
}

// ---------------------------------------------------------------------------
// Popping a stream out
// ---------------------------------------------------------------------------

/** Whether this browser can put a video in a window of its own. */
export function canPopOut(): boolean {
    return (
        typeof document !== "undefined" &&
        document.pictureInPictureEnabled === true &&
        typeof HTMLVideoElement !== "undefined" &&
        "requestPictureInPicture" in HTMLVideoElement.prototype
    );
}

/** The stream in its own window right now, if any. */
export function poppedStream(): string | null {
    return popped?.key ?? null;
}

export function usePoppedStream(): string | null {
    return useSyncExternalStore(subscribe, poppedStream, () => null);
}

/**
 * Put a stream in a floating window that stays on top of everything.
 *
 * A video element of its own, parked out of sight, rather than the tile's:
 * the tile goes away when somebody walks out of the conversation, and the
 * window is meant to outlive that. Must be called from the press that asked
 * for it - a browser refuses the window without one.
 */
export async function popOut(key: string, stream: MediaStream): Promise<boolean> {
    if (!canPopOut()) return false;
    closePopOut();
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.setAttribute("aria-hidden", "true");
    video.style.cssText =
        "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;bottom:0";
    document.body.append(video);
    popped = { key, video };
    changed();
    video.addEventListener("leavepictureinpicture", () => {
        if (popped?.video === video) closePopOut();
    });
    try {
        await video.play();
        await video.requestPictureInPicture();
        return true;
    } catch {
        if (popped?.video === video) closePopOut();
        return false;
    }
}

/** Close the floating window, if one is open. */
export function closePopOut(): void {
    const current = popped;
    if (!current) return;
    popped = null;
    if (document.pictureInPictureElement === current.video) {
        void document.exitPictureInPicture().catch(() => undefined);
    }
    current.video.srcObject = null;
    current.video.remove();
    changed();
}

// ---------------------------------------------------------------------------
// Muting a stream
// ---------------------------------------------------------------------------

const MUTED_PREFIX = "polaris.call.stream-muted.";
const MUTED_CHANGED = "polaris:call-stream-muted";

export function streamMuted(person: string): boolean {
    if (typeof window === "undefined") return false;
    try {
        return window.localStorage.getItem(MUTED_PREFIX + person) === "1";
    } catch {
        return false;
    }
}

export function setStreamMuted(person: string, muted: boolean): void {
    if (typeof window === "undefined") return;
    try {
        if (muted) window.localStorage.setItem(MUTED_PREFIX + person, "1");
        else window.localStorage.removeItem(MUTED_PREFIX + person);
    } catch {
        // It still applies to what is playing; it just will not be remembered.
    }
    window.dispatchEvent(new Event(MUTED_CHANGED));
}

/** Whether this sharer's stream is muted here, and the switch. */
export function useStreamMuted(person: string): [boolean, (muted: boolean) => void] {
    const [muted, setMuted] = useState(false);
    useEffect(() => {
        const read = () => setMuted(streamMuted(person));
        read();
        window.addEventListener(MUTED_CHANGED, read);
        window.addEventListener("storage", read);
        return () => {
            window.removeEventListener(MUTED_CHANGED, read);
            window.removeEventListener("storage", read);
        };
    }, [person]);
    const change = useCallback(
        (next: boolean) => {
            setMuted(next);
            setStreamMuted(person, next);
        },
        [person]
    );
    return [muted, change];
}

// ---------------------------------------------------------------------------
// How loud the voices are
// ---------------------------------------------------------------------------

/**
 * What the voices are played at, as a multiple of each person's own volume.
 *
 * Two things lower them and they compound: this browser talking, when the
 * reader asked for ducking, and a stream with sound playing here, by the stream
 * attenuation strength.
 */
export function voiceScale(input: {
    /** 0 to 100, or 0 when this browser is not talking or ducking is off. */
    readonly ducking: number;
    /** Whether a watched stream is audible right now. */
    readonly streamPlaying: boolean;
    /** 0 to 100. */
    readonly streamAttenuation: number;
}): number {
    const part = (percent: number) => Math.min(1, Math.max(0, 1 - percent / 100));
    return part(input.ducking) * (input.streamPlaying ? part(input.streamAttenuation) : 1);
}
