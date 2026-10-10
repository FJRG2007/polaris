/**
 * Any audio file the browser can play, as the Ogg Vorbis file Minecraft needs.
 *
 * The game plays nothing else, and the dashboard image carries no audio tools,
 * so the conversion happens here, in the operator's browser: the browser's own
 * decoder reads the file (MP3, WAV, M4A/AAC, FLAC, Opus, WebM - whatever it can
 * play), an offline audio context resamples it to 44.1 kHz and mixes anything
 * past two channels down to stereo, and the reference libvorbis encoder,
 * compiled to WebAssembly (the `wasm-media-encoders` package), writes the Ogg
 * file. A file that is already Ogg Vorbis the game can play is sent as it is.
 *
 * Browser-only. The server checks the result again (`readVorbis`) whatever
 * this says.
 */

import { createEncoder } from "wasm-media-encoders";
import { MAX_SOUND_BYTES, readVorbis } from "./sounds";

/** Where the app's bundle serves the encoder (staged by `scripts/stage-assets.mjs`). */
const ENCODER_URL = "/api/app-bundles/game-servers/current/assets/ogg-encoder/ogg.wasm";
/** The largest file read at all: a long WAV is big before it is compressed. */
export const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const SAMPLE_RATE = 44_100;
/** Libvorbis's quality scale, best first; a smaller one is tried when the
 *  result is past one sound's limit. 4 is about 128 kbit/s in stereo. */
const QUALITIES = [4, 1, -1] as const;
const CHUNK = 8_192;

export type EncodeFailure =
    /** Bigger than anything worth reading. */
    | "tooLarge"
    /** The browser could not read it as audio. */
    | "unreadable"
    /** Even at the lowest quality it is past one sound's limit. */
    | "tooLong"
    /** The encoder did not load or failed. */
    | "encoder";

export class EncodeError extends Error {
    constructor(readonly reason: EncodeFailure) {
        super(reason);
    }
}

let encoderModule: Promise<Uint8Array> | null = null;

function encoderBytes(): Promise<Uint8Array> {
    encoderModule ??= fetch(ENCODER_URL)
        .then((answer) => {
            if (!answer.ok) throw new Error(`encoder ${answer.status}`);
            return answer.arrayBuffer();
        })
        .then((buffer) => new Uint8Array(buffer))
        .catch((caught) => {
            encoderModule = null;
            throw caught;
        });
    return encoderModule;
}

async function decode(bytes: Uint8Array): Promise<AudioBuffer> {
    // An offline context decodes without asking for the speakers, so nothing
    // needs a click first and nothing is heard.
    const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    const copy = bytes.slice().buffer;
    return context.decodeAudioData(copy);
}

/** The audio at 44.1 kHz, in one or two channels. */
async function resample(decoded: AudioBuffer): Promise<AudioBuffer> {
    const channels = decoded.numberOfChannels > 1 ? 2 : 1;
    if (decoded.sampleRate === SAMPLE_RATE && decoded.numberOfChannels === channels) return decoded;
    const length = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
    const context = new OfflineAudioContext(channels, length, SAMPLE_RATE);
    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(context.destination);
    source.start();
    return context.startRendering();
}

/**
 * Samples as an Ogg Vorbis file: one array per channel (one or two), at
 * `sampleRate`. `wasm` is the encoder's module. Exported for the test, which
 * runs the real encoder.
 */
export async function encodePcm(
    samples: readonly Float32Array[],
    sampleRate: number,
    quality: number,
    wasm: Uint8Array
): Promise<Uint8Array> {
    const encoder = await createEncoder("audio/ogg", wasm);
    encoder.configure({ channels: samples.length as 1 | 2, sampleRate, vbrQuality: quality });
    const length = samples[0]?.length ?? 0;
    const parts: Uint8Array[] = [];
    for (let at = 0; at < length; at += CHUNK) {
        const out = encoder.encode(samples.map((channel) => channel.subarray(at, at + CHUNK)));
        // What comes back still belongs to the encoder and is overwritten by
        // the next call.
        if (out.length > 0) parts.push(out.slice());
    }
    parts.push(encoder.finalize().slice());
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const file = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        file.set(part, offset);
        offset += part.length;
    }
    return file;
}

async function encode(audio: AudioBuffer, quality: number): Promise<Uint8Array> {
    const samples = Array.from({ length: audio.numberOfChannels }, (_, at) =>
        audio.getChannelData(at)
    );
    return encodePcm(samples, audio.sampleRate, quality, await encoderBytes());
}

/**
 * The file as one the game plays. `converted` says whether it had to be: an
 * Ogg Vorbis file with one or two channels is sent untouched.
 */
export async function toGameSound(file: Blob): Promise<{ bytes: Uint8Array; converted: boolean }> {
    if (file.size > MAX_INPUT_BYTES) throw new EncodeError("tooLarge");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const vorbis = readVorbis(bytes);
    if (vorbis.ok && bytes.length <= MAX_SOUND_BYTES) return { bytes, converted: false };
    let audio: AudioBuffer;
    try {
        audio = await resample(await decode(bytes));
    } catch {
        throw new EncodeError("unreadable");
    }
    for (const quality of QUALITIES) {
        let encoded: Uint8Array;
        try {
            encoded = await encode(audio, quality);
        } catch {
            throw new EncodeError("encoder");
        }
        if (encoded.length <= MAX_SOUND_BYTES) return { bytes: encoded, converted: true };
    }
    throw new EncodeError("tooLong");
}
