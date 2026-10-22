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
 *
 * A press has to sound the moment it lands, the way Discord's does, so nothing
 * between the click and the speaker waits on anything: the clips a call can
 * play are fetched ahead (`warmClips`), each one keeps an element already
 * loaded and already pointed at the speaker, and the person who pressed hears
 * it here at once (`playOwnClip`) rather than when the room carries it back.
 */

import { speakerDevice } from "@/lib/speaker-choice";
import { playThroughChosenSpeaker } from "./speaker-device";
import { defaultSoundUrl, parseSoundRef } from "@/lib/chat/soundboard";

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
            ready.delete(oldest[0]);
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
 * Fetch these clips now, so the first press of each sounds at once.
 *
 * Called when a call opens and again when the picker does. A clip this browser
 * may not read (a sound from a space the reader is not in) fails here quietly
 * and is fetched again from the address a play carries, as before.
 */
export function warmClips(refs: Iterable<string>): void {
    if (typeof window === "undefined") return;
    let left = KEEP;
    for (const ref of refs) {
        if (left-- <= 0) return;
        const clip = clipFor(ref, null);
        if (clip) void clip.then((src) => prepare(ref, src)).catch(() => undefined);
    }
}

/** An element per clip, loaded and pointed at the speaker before it is needed. */
const ready = new Map<string, Promise<HTMLAudioElement>>();

type Routed = HTMLAudioElement & { sinkId?: string };

function prepare(ref: string, src: string): Promise<HTMLAudioElement> {
    const existing = ready.get(ref);
    if (existing) return existing;
    const element = new Audio(src);
    element.preload = "auto";
    const made = playThroughChosenSpeaker(element).then(() => element);
    ready.set(ref, made);
    return made;
}

/** The ready element for a clip, handed over once; the next one is made behind it. */
async function take(ref: string, src: string): Promise<HTMLAudioElement> {
    const made = prepare(ref, src);
    ready.delete(ref);
    void prepare(ref, src);
    const element = await made;
    // The speaker was changed since it was made: moved now, before it plays.
    const chosen = speakerDevice();
    const sink = (element as Routed).sinkId;
    if (chosen && sink !== undefined && sink !== chosen) await playThroughChosenSpeaker(element);
    return element;
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
    options: { url?: string | null; volume: number; channel: string }
): Promise<void> {
    await start(ref, options);
}

async function start(
    ref: string,
    { url = null, volume, channel }: { url?: string | null; volume: number; channel: string }
): Promise<HTMLAudioElement | null> {
    if (volume <= 0) return null;
    const clip = clipFor(ref, url);
    if (!clip) return null;
    const src = await clip;
    const element = await take(ref, src);
    playing.get(channel)?.pause();
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
    const played = await element.play().then(
        () => true,
        () => false
    );
    if (played) return element;
    done();
    return null;
}

/**
 * Plays this browser started itself and is waiting for the room to carry back,
 * by seat and sound, each until when it is still expected.
 */
const echoes = new Map<string, number>();

/** Longer than any round trip a play makes; past it, an echo is a new play. */
const ECHO_MS = 10_000;

const echoKey = (channel: string, ref: string) => `${channel} ${ref}`;

/**
 * Sound the reader's own press here, now, and expect the room's copy of it.
 *
 * At the volume the room's copy would have arrived at, so nothing changes but
 * when it is heard. Returns the way to take it back: the server refused the
 * play (a cooldown, a permission), so it stops and nothing is expected.
 */
export function playOwnClip(
    ref: string,
    { volume, channel }: { volume: number; channel: string }
): { readonly settle: () => void; readonly undo: () => void } {
    const key = echoKey(channel, ref);
    const until = Date.now() + ECHO_MS;
    echoes.set(key, until);
    const started = start(ref, { volume, channel }).catch(() => null);
    // Nothing sounded here, so the room's copy is what the reader hears.
    void started.then((element) => {
        if (!element && echoes.get(key) === until) echoes.delete(key);
    });
    return {
        // Nobody else is connected, so no copy is coming back.
        settle: () => echoes.delete(key),
        undo: () => {
            echoes.delete(key);
            void started.then((element) => {
                if (!element || playing.get(channel) !== element) return;
                element.pause();
                playing.delete(channel);
                changed();
            });
        }
    };
}

/**
 * Whether a play the room carried is this browser's own, already sounding.
 *
 * Matched on the seat and the sound together: somebody else pressing the same
 * sound a moment later is a different seat and is heard as usual. Each press
 * swallows one copy.
 */
export function ownEcho(from: string, ref: string): boolean {
    const key = echoKey(from, ref);
    const until = echoes.get(key);
    if (until === undefined) return false;
    echoes.delete(key);
    return until >= Date.now();
}

/** Hear a sound here, before playing it to anybody. */
export function previewSound(ref: string, volume: number): Promise<void> {
    return playClip(ref, { volume, channel: "preview" });
}
