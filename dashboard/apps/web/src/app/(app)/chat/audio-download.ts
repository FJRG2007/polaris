"use client";

/**
 * Saving a recording as something people can actually use.
 *
 * A voice message is recorded by the browser, and what the browser records is
 * Opus in a WebM container - or, on Safari, AAC in MP4. That is the right thing
 * to send: it is small, it is what `MediaRecorder` produces without a second
 * encode, and every browser plays it back. It is the wrong thing to hand
 * somebody as a file. A `.webm` will not open in most desktop audio players, it
 * will not go into a video editor, phones do odd things with it, and the person
 * who asked for the recording did not ask for a container format decision.
 *
 * So the file is converted here, in the page, at the moment somebody saves it -
 * never on the way in. Storing a second copy as MP3 would double the space every
 * voice message costs, forever, so that a fraction of them could be downloaded
 * once. The tradeoff is a few seconds of work in the tab, which is the right
 * place to spend it: it is one person, once, on their own machine, and the
 * server does nothing at all.
 *
 * MP3 is the default because it is the one that opens everywhere. WAV is offered
 * for anybody putting it into an editor, and the original is offered because it
 * is the smallest and it is what was actually said - no re-encode, no loss.
 */

import { downloadFile } from "./links";
import { downloadBytes } from "@/lib/download";

export type AudioFormat = "mp3" | "wav" | "original";

/** What the menu lists, in the order it lists it. The first is the default. */
export const AUDIO_FORMATS: readonly { format: AudioFormat; label: string }[] = [
    { format: "mp3", label: "MP3" },
    { format: "wav", label: "WAV" },
    { format: "original", label: "Original" }
];

/**
 * Where the encoder is served from.
 *
 * A file rather than an import, and deliberately so. It is the only MP3 encoder
 * there is - every one of them descends from LAME - and it carries LAME's
 * licence, which asks that somebody be able to replace it with their own build.
 * Bundled into the application that would not be true, and Polaris' own licence
 * is not that one. Served as its own file it is: it is fetched by URL, it is
 * replaceable on disk, and it stays out of the bundle of a page that will never
 * encode anything. The noise-suppression models next door are staged the same
 * way for the same second reason.
 */
const ENCODER = "/audio/mp3-encoder.js";

/**
 * How good the MP3 is.
 *
 * One voice, mono, in a room: 96 kbps is past the point where anybody can hear
 * the encoder. Two channels is more likely to be music somebody attached, so it
 * gets the rate nobody argues with.
 */
const MONO_KBPS = 96;
const STEREO_KBPS = 128;

/** What the encoder will accept. Anything else is resampled first. */
const RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

/** What to resample to when the recording is at a rate the encoder refuses. */
const FALLBACK_RATE = 44100;

/** How many blocks to encode before letting the page draw. Five minutes of audio
 *  is around thirteen thousand of them, and a tab that stops answering for the
 *  length of that is a tab somebody reloads. */
const BLOCKS_PER_TURN = 128;

/** Samples per MP3 block. Not a choice - it is what the format is made of. */
const BLOCK = 1152;

/** The one thing this uses from the encoder, named so the rest of it is not
 *  assumed to exist. */
interface Mp3Encoder {
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
}

interface LameGlobal {
    Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => Mp3Encoder;
}

/**
 * Save a recording under a format somebody chose.
 *
 * The original is a plain download, so it costs nothing and never fails. The
 * other two read the bytes into the page and re-encode them, and either can fail
 * on a browser that will not decode the container - which is answered honestly
 * rather than by silently handing over the WebM they did not ask for.
 *
 * @returns null when it worked, or a sentence to show when it did not.
 */
export async function saveRecording(
    url: string,
    name: string,
    format: AudioFormat
): Promise<string | null> {
    if (format === "original") {
        downloadFile(url, name);
        return null;
    }

    let audio: AudioBuffer;
    try {
        const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}download=1`);
        if (!response.ok) return "That recording could not be read.";
        audio = await decode(await response.arrayBuffer());
    } catch {
        return "This browser could not open that recording.";
    }

    try {
        const blob =
            format === "mp3" ? await toMp3(await playable(audio)) : asWav(audio);
        downloadBytes(blob, renamed(name, format));
        return null;
    } catch {
        return `That recording could not be turned into ${format.toUpperCase()}. Save the original instead.`;
    }
}

/** What a file is called at the end, for the menu to show beside "Original" -
 *  the one entry whose format is whatever this particular recording happens to
 *  be. Empty for a name with no extension, which draws as nothing. */
export function extensionOf(name: string): string {
    return /\.([^./\\]+)$/.exec(name)?.[1] ?? "";
}

/** The same name wearing the extension of what is actually in the file. */
export function renamed(name: string, format: AudioFormat): string {
    if (format === "original") return name;
    const stem = name.replace(/\.[^./\\]+$/, "") || "audio";
    return `${stem}.${format}`;
}

/** The recording, as samples. */
async function decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    const context = new AudioContext();
    try {
        return await context.decodeAudioData(bytes);
    } finally {
        // Closed either way: a context per download, left open, is a hardware
        // audio thread per download.
        await context.close().catch(() => undefined);
    }
}

/**
 * The same audio at a rate the encoder accepts.
 *
 * Almost always the one it already has - a browser decodes at its own rate, and
 * that is 44.1 or 48 kHz everywhere - so this is the rare path rather than the
 * normal one, and it returns the original object untouched when it can.
 */
async function playable(audio: AudioBuffer): Promise<AudioBuffer> {
    if (RATES.includes(audio.sampleRate)) return audio;

    const length = Math.ceil((audio.duration * FALLBACK_RATE) as number);
    const offline = new OfflineAudioContext(audio.numberOfChannels, length, FALLBACK_RATE);
    const source = offline.createBufferSource();
    source.buffer = audio;
    source.connect(offline.destination);
    source.start();
    return await offline.startRendering();
}

/**
 * Encode, in blocks, giving the page a turn between batches.
 *
 * The encoder is synchronous and a five-minute recording is a few seconds of
 * work. Done in one go that is a frozen tab; done like this it is a tab that
 * stays alive while a menu item spins.
 */
async function toMp3(audio: AudioBuffer): Promise<Blob> {
    const lame = await encoder();
    const channels = Math.min(audio.numberOfChannels, 2);
    const encode = new lame.Mp3Encoder(
        channels,
        audio.sampleRate,
        channels > 1 ? STEREO_KBPS : MONO_KBPS
    );

    const left = whole(audio.getChannelData(0));
    const right = channels > 1 ? whole(audio.getChannelData(1)) : undefined;
    const parts: Int8Array[] = [];

    for (let at = 0, block = 0; at < left.length; at += BLOCK, block += 1) {
        const chunk = encode.encodeBuffer(
            left.subarray(at, at + BLOCK),
            right?.subarray(at, at + BLOCK)
        );
        if (chunk.length > 0) parts.push(chunk);
        if (block % BLOCKS_PER_TURN === BLOCKS_PER_TURN - 1) {
            await new Promise((settle) => setTimeout(settle, 0));
        }
    }
    const last = encode.flush();
    if (last.length > 0) parts.push(last);

    return new Blob(parts as unknown as BlobPart[], { type: "audio/mpeg" });
}

/** Float samples as the whole numbers the encoder works in. */
function whole(samples: Float32Array): Int16Array {
    const out = new Int16Array(samples.length);
    for (let at = 0; at < samples.length; at += 1) {
        // Clamped rather than wrapped: a sample over the line is loud, and
        // wrapping turns loud into a click.
        const value = Math.max(-1, Math.min(1, samples[at] ?? 0));
        out[at] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    return out;
}

/** The encoder, fetched once and left on the page for the next one. */
async function encoder(): Promise<LameGlobal> {
    const already = (globalThis as { lamejs?: LameGlobal }).lamejs;
    if (already?.Mp3Encoder) return already;

    await new Promise<void>((settle, fail) => {
        const script = document.createElement("script");
        script.src = ENCODER;
        script.onload = () => settle();
        script.onerror = () => fail(new Error("The encoder could not be loaded"));
        document.head.append(script);
    });

    const loaded = (globalThis as { lamejs?: LameGlobal }).lamejs;
    if (!loaded?.Mp3Encoder) throw new Error("The encoder did not load");
    return loaded;
}

/**
 * The samples, as a WAV file.
 *
 * Written by hand because a WAV is a header and the samples, and the smallest
 * honest way to offer a lossless save is forty lines rather than a dependency.
 * Which is also why it is exported: a header written wrong produces a file that
 * downloads perfectly and opens in nothing, and nobody would find that by using
 * it.
 */
export function asWav(audio: AudioBuffer): Blob {
    const channels = audio.numberOfChannels;
    const frames = audio.length;
    const bytes = frames * channels * 2;
    const buffer = new ArrayBuffer(44 + bytes);
    const view = new DataView(buffer);

    const text = (at: number, value: string) => {
        for (let index = 0; index < value.length; index += 1) {
            view.setUint8(at + index, value.charCodeAt(index));
        }
    };

    text(0, "RIFF");
    view.setUint32(4, 36 + bytes, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    // 1 is uncompressed whole-number samples, which is the only kind written
    // here.
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, audio.sampleRate, true);
    view.setUint32(28, audio.sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, bytes, true);

    // Interleaved, which is what the format is: every channel of a frame
    // together, frame after frame.
    const tracks = Array.from({ length: channels }, (_, index) => audio.getChannelData(index));
    let at = 44;
    for (let frame = 0; frame < frames; frame += 1) {
        for (const track of tracks) {
            const value = Math.max(-1, Math.min(1, track[frame] ?? 0));
            view.setInt16(at, value < 0 ? value * 0x8000 : value * 0x7fff, true);
            at += 2;
        }
    }
    return new Blob([buffer], { type: "audio/wav" });
}
