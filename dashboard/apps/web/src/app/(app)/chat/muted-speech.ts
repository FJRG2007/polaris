"use client";

/**
 * Talking into a muted microphone.
 *
 * The most common thing to go wrong in a call, and the one the person it happens
 * to finds out about last: everybody else hears nothing and waits, and they go on
 * talking. So while the microphone is muted it is still listened to here - on a
 * copy of the device track that is never published and never leaves this
 * browser - and when it hears somebody speaking, the mic button says so.
 *
 * Only a microphone that is already open is listened to. No stream, no
 * permission, or no Web Audio means no detection, and nothing is said about it.
 *
 * The rules are plain arithmetic, tested on their own: how loud and how much of
 * a short window counts as speaking rather than a cough or a door, and how often
 * the reader may be told.
 */

import { useEffect, useRef, useState } from "react";
import { measureVoice } from "./voice-level";

/** The level, on `measureVoice`'s 0-100 scale, that counts as a voice. A little
 *  above the voice-activity default, because a false alarm here accuses
 *  somebody of talking who was not. */
export const SPEECH_LEVEL = 15;
/** How many readings make up the window speech is judged over. */
export const SPEECH_WINDOW = 8;
/** How many of them must be loud: half a window, so a syllable is not enough
 *  and a sentence is. */
export const SPEECH_FRAMES = 4;
/** How often the microphone is read. Eight readings is under a second. */
export const SAMPLE_MS = 100;
/** How long the notice stays up. */
export const SHOW_FOR_MS = 4_000;
/** The least time between two notices. Somebody who is talking while muted on
 *  purpose - to the room they are in - is told once, not every sentence. */
export const WARN_EVERY_MS = 30_000;

/** Whether the recent readings sound like somebody speaking. */
export function heardSpeech(
    recent: readonly number[],
    level: number = SPEECH_LEVEL,
    frames: number = SPEECH_FRAMES
): boolean {
    let loud = 0;
    for (const reading of recent) if (reading >= level) loud += 1;
    return loud >= frames;
}

/** Whether another notice may be shown, given when the last one was. */
export function mayWarn(
    lastAt: number | null,
    now: number,
    every: number = WARN_EVERY_MS
): boolean {
    return lastAt === null || now - lastAt >= every;
}

/**
 * Whether to show the notice right now.
 *
 * `track` is the device's own microphone track; `listening` is whether the
 * reader is muted and this browser is the one that should be heard. The track
 * itself is left alone: what is measured is a clone with its own enabled flag,
 * stopped with the measurement.
 */
export function useMutedSpeech(track: MediaStreamTrack | null, listening: boolean): boolean {
    const [warning, setWarning] = useState(false);
    // Kept across mutes, so muting again does not reset the limit.
    const lastAt = useRef<number | null>(null);

    useEffect(() => {
        if (!listening || !track || track.readyState !== "live") return;
        let copy: MediaStreamTrack;
        try {
            copy = track.clone();
        } catch {
            return;
        }
        // The call's own track is disabled while muted, which reads as silence.
        copy.enabled = true;
        const meter = measureVoice(copy);
        if (!meter) {
            copy.stop();
            return;
        }
        const recent: number[] = [];
        let hide: ReturnType<typeof setTimeout> | null = null;
        const timer = setInterval(() => {
            recent.push(meter.read());
            if (recent.length > SPEECH_WINDOW) recent.shift();
            if (!heardSpeech(recent)) return;
            const now = Date.now();
            if (!mayWarn(lastAt.current, now)) return;
            lastAt.current = now;
            recent.length = 0;
            setWarning(true);
            if (hide) clearTimeout(hide);
            hide = setTimeout(() => setWarning(false), SHOW_FOR_MS);
        }, SAMPLE_MS);

        return () => {
            clearInterval(timer);
            if (hide) clearTimeout(hide);
            meter.stop();
            copy.stop();
            setWarning(false);
        };
    }, [track, listening]);

    return warning;
}
