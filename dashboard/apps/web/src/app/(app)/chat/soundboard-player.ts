"use client";

/**
 * Hearing a sound somebody played, and previewing one before playing it.
 *
 * Each browser plays the clip itself, at its own volume, through the speaker
 * the call is using - which is what lets one listener turn the soundboard down,
 * or one person's sounds off, without anybody else hearing any difference. The
 * clip is never mixed into anybody's microphone.
 *
 * A space's sound and a default are each fetched once per tab and kept - a
 * default from the files Polaris ships (`defaultSoundUrl`). Both become the
 * same thing: a WAV behind an object URL, played by an audio element so
 * `setSinkId` can send it to the chosen speaker.
 */

import { defaultSoundUrl, parseSoundRef } from "@/lib/chat/soundboard";
import { playThroughChosenSpeaker } from "./speaker-device";

/** Every clip this tab has, by reference, as an object URL. */
const clips = new Map<string, Promise<string>>();

/** How many clips are kept before the oldest is let go. Two spaces' worth. */
const KEEP = 96;

function remember(ref: string, made: Promise<string>): Promise<string> {
    made.catch(() => clips.delete(ref));
    clips.set(ref, made);
    if (clips.size > KEEP) {
        const [oldest] = clips;
        if (oldest) {
            clips.delete(oldest[0]);
            void oldest[1].then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
        }
    }
    return made;
}

/**
 * The clip for one reference, as a URL an audio element can play.
 *
 * @param url - Where a space's sound is fetched from: the address a play carried
 *   (signed for the call), or the plain one for whoever reaches its space.
 */
function clipFor(ref: string, url: string | null): Promise<string> | null {
    const cached = clips.get(ref);
    if (cached) return cached;
    const parsed = parseSoundRef(ref);
    if (!parsed) return null;
    const from =
        parsed.kind === "default"
            ? defaultSoundUrl(parsed.id)
            : (url ?? `/api/chat/sounds/${parsed.id}`);
    return remember(
        ref,
        fetch(from, { cache: "force-cache" }).then(async (answer) => {
            if (!answer.ok) throw new Error(`sound ${answer.status}`);
            return URL.createObjectURL(await answer.blob());
        })
    );
}

/**
 * Play one clip at a volume, and stop it if it is still going when the next one
 * from the same person starts - one person mashing a button is one sound at a
 * time, not a pile of them.
 */
const playing = new Map<string, HTMLAudioElement>();

/** Whoever is drawing a stop control, told each time what is playing changes. */
const listeners = new Set<() => void>();

function changed(): void {
    for (const listener of listeners) listener();
}

/** Be told when a clip starts or stops. Returns the way to stop being told. */
export function onClipsChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Whether anything is playing here - from `channel` alone when one is named. */
export function clipsPlaying(channel?: string): boolean {
    return channel === undefined ? playing.size > 0 : playing.has(channel);
}

/** Stop what is playing here: one person's sound, or every sound when no
 *  channel is named. Only this browser - see `stopSound` for the room. */
export function stopClips(channel?: string): void {
    for (const [key, element] of playing) {
        if (channel !== undefined && key !== channel) continue;
        element.pause();
        playing.delete(key);
    }
    changed();
}

export async function playClip(
    ref: string,
    { url = null, volume, channel }: { url?: string | null; volume: number; channel: string }
): Promise<void> {
    if (volume <= 0) return;
    const clip = clipFor(ref, url);
    if (!clip) return;
    const src = await clip;
    playing.get(channel)?.pause();
    const element = new Audio(src);
    element.volume = Math.min(1, Math.max(0, volume));
    playing.set(channel, element);
    changed();
    const done = () => {
        if (playing.get(channel) !== element) return;
        playing.delete(channel);
        changed();
    };
    element.addEventListener("ended", done);
    element.addEventListener("error", done);
    await playThroughChosenSpeaker(element).catch(() => undefined);
    await element.play().catch(() => undefined);
}

/** Hear a sound here, before playing it to anybody. */
export function previewSound(ref: string, volume: number): Promise<void> {
    return playClip(ref, { volume, channel: "preview" });
}
