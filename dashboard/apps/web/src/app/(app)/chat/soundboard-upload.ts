"use client";

/**
 * Turning whatever somebody chose into a soundboard sound, in their browser.
 *
 * The browser's own decoder reads the file - MP3, Ogg, WAV, M4A, FLAC, WebM,
 * anything it can play - and an offline audio context mixes it to one channel,
 * resamples it to 44.1 kHz and cuts out the window that was chosen: Discord's
 * upload asks for a clip of at most 5.2 seconds out of a longer file, and so
 * does this. The result is the WAV the server checks again (`readWav`).
 */

import { SOUND_MAX_MS } from "@/lib/chat/soundboard";
import { encodeWav, SOUND_SAMPLE_RATE } from "@/lib/chat/sound-file";

/** The largest file read at all: a long WAV is big before anything is cut. */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

/** What a file chooser offers. */
export const SOUND_ACCEPT = ".mp3,.ogg,.oga,.wav,.m4a,.aac,.flac,.opus,.webm,audio/*";

export type DecodeFailure = "tooLarge" | "unreadable";

/** A file, decoded once, ready to be cut as many times as the slider moves. */
export interface DecodedSound {
    readonly buffer: AudioBuffer;
    readonly durationMs: number;
}

export async function decodeSound(
    file: File
): Promise<{ sound?: DecodedSound; failure?: DecodeFailure }> {
    if (file.size > MAX_SOURCE_BYTES) return { failure: "tooLarge" };
    try {
        const bytes = await file.arrayBuffer();
        // An offline context decodes without asking for the speakers, so
        // nothing needs a click first and nothing is heard.
        const buffer = await new OfflineAudioContext(1, 1, SOUND_SAMPLE_RATE).decodeAudioData(bytes);
        if (buffer.duration <= 0) return { failure: "unreadable" };
        return { sound: { buffer, durationMs: Math.round(buffer.duration * 1000) } };
    } catch {
        return { failure: "unreadable" };
    }
}

/**
 * The window from `startMs`, at most 5.2 seconds long, as the WAV to upload.
 *
 * Rendered rather than sliced, so the mix-down and the resampling are the
 * browser's own, and with a few milliseconds of fade at both ends so a cut in
 * the middle of a word does not click.
 */
export async function cutSound(sound: DecodedSound, startMs: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(startMs, Math.max(0, sound.durationMs - 1))) / 1000;
    const seconds = Math.min(SOUND_MAX_MS / 1000, sound.buffer.duration - start);
    const length = Math.max(1, Math.floor(seconds * SOUND_SAMPLE_RATE));
    const ctx = new OfflineAudioContext(1, length, SOUND_SAMPLE_RATE);
    const source = ctx.createBufferSource();
    const fade = ctx.createGain();
    source.buffer = sound.buffer;
    const edge = Math.min(0.01, seconds / 4);
    fade.gain.setValueAtTime(0, 0);
    fade.gain.linearRampToValueAtTime(1, edge);
    fade.gain.setValueAtTime(1, Math.max(edge, seconds - edge));
    fade.gain.linearRampToValueAtTime(0, seconds);
    source.connect(fade).connect(ctx.destination);
    source.start(0, start, seconds);
    const rendered = await ctx.startRendering();
    return encodeWav(rendered.getChannelData(0));
}

/** A name to start from: the file's own, without its extension, cut to fit. */
export function nameFromFile(file: File, max: number): string {
    const bare = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    return [...bare].slice(0, max).join("").trim();
}
