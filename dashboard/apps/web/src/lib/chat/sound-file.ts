/**
 * A soundboard sound's file: written by the uploader's browser, checked by the
 * server, and the same simple format either way.
 *
 * Discord takes MP3 and Ogg. Polaris takes anything the uploader's browser can
 * play - MP3, Ogg, WAV, M4A, FLAC, WebM - and the browser turns it into one
 * format before it is sent: 16-bit PCM WAV, one channel, 44.1 kHz. Five point
 * two seconds of that is 459 KB, under Discord's 512 KB, with no encoder to
 * ship and nothing for a browser to fail to decode on the way back out.
 *
 * And it is the one format whose length is a fact rather than an estimate. A
 * duration read off an MP3 is a guess the file makes about itself; a WAV's is
 * its sample count divided by its rate, so the 5.2-second limit is checked
 * exactly, on the server, whatever the uploader's browser claimed.
 *
 * Pure: the browser writes with `encodeWav`, the server reads with `readWav`.
 */

import { SOUND_MAX_BYTES, SOUND_MAX_MS } from "./soundboard";

/** What every sound is written at. */
export const SOUND_SAMPLE_RATE = 44_100;

/** The header `encodeWav` writes, and the only one `readWav` hands back. */
const HEADER_BYTES = 44;

/** Why a file is refused, as a word the screen turns into a sentence. */
export type SoundFileProblem = "empty" | "size" | "type" | "length";

export type WavInfo =
    | {
          readonly ok: true;
          readonly channels: number;
          readonly sampleRate: number;
          readonly durationMs: number;
          /** The same audio under a clean header and nothing else: no metadata
           *  chunks, nothing after the samples. What is stored. */
          readonly canonical: Uint8Array;
      }
    | { readonly ok: false; readonly problem: SoundFileProblem };

function ascii(bytes: Uint8Array, at: number, length: number): string {
    return String.fromCharCode(...bytes.subarray(at, at + length));
}

/**
 * What a WAV file holds, from its own structure.
 *
 * Walks the chunks rather than assuming the 44-byte layout, because a file
 * from an editor carries `LIST` and `bext` chunks wherever it likes. Only plain
 * 16-bit PCM is taken - everything `encodeWav` writes - so nothing else has to
 * be decoded on the server to know what it is.
 */
export function readWav(bytes: Uint8Array): WavInfo {
    if (bytes.length === 0) return { ok: false, problem: "empty" };
    if (bytes.length > SOUND_MAX_BYTES) return { ok: false, problem: "size" };
    if (
        bytes.length < HEADER_BYTES ||
        ascii(bytes, 0, 4) !== "RIFF" ||
        ascii(bytes, 8, 4) !== "WAVE"
    )
        return { ok: false, problem: "type" };

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 12;
    let format: { channels: number; sampleRate: number; bits: number; pcm: boolean } | null = null;
    let data: Uint8Array | null = null;
    while (at + 8 <= bytes.length) {
        const id = ascii(bytes, at, 4);
        const size = view.getUint32(at + 4, true);
        const body = at + 8;
        if (body + size > bytes.length) {
            // A data chunk whose declared size runs past the end is the one
            // truncation that is common and harmless: cut to what is there.
            if (id === "data") {
                data = bytes.subarray(body);
                break;
            }
            return { ok: false, problem: "type" };
        }
        if (id === "fmt " && size >= 16) {
            format = {
                pcm: view.getUint16(body, true) === 1,
                channels: view.getUint16(body + 2, true),
                sampleRate: view.getUint32(body + 4, true),
                bits: view.getUint16(body + 14, true)
            };
        } else if (id === "data") {
            data = bytes.subarray(body, body + size);
            break;
        }
        // Chunks are padded to an even length.
        at = body + size + (size % 2);
    }

    if (!format || !data) return { ok: false, problem: "type" };
    if (!format.pcm || format.bits !== 16) return { ok: false, problem: "type" };
    if (format.channels < 1 || format.channels > 2) return { ok: false, problem: "type" };
    if (format.sampleRate < 8_000 || format.sampleRate > 48_000)
        return { ok: false, problem: "type" };

    const frame = format.channels * 2;
    const frames = Math.floor(data.length / frame);
    if (frames === 0) return { ok: false, problem: "empty" };
    const durationMs = Math.round((frames / format.sampleRate) * 1000);
    if (durationMs > SOUND_MAX_MS) return { ok: false, problem: "length" };

    const samples = data.subarray(0, frames * frame);
    return {
        ok: true,
        channels: format.channels,
        sampleRate: format.sampleRate,
        durationMs,
        canonical: wavBytes(samples, format.channels, format.sampleRate)
    };
}

/** A 44-byte PCM header in front of samples that are already 16-bit. */
function wavBytes(samples: Uint8Array, channels: number, sampleRate: number): Uint8Array {
    const out = new Uint8Array(HEADER_BYTES + samples.length);
    const view = new DataView(out.buffer);
    const write = (at: number, text: string) => {
        for (let index = 0; index < text.length; index += 1)
            out[at + index] = text.charCodeAt(index);
    };
    write(0, "RIFF");
    view.setUint32(4, 36 + samples.length, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    view.setUint32(40, samples.length, true);
    out.set(samples, HEADER_BYTES);
    return out;
}

/**
 * Mono samples between -1 and 1 as a WAV file.
 *
 * Clipped rather than wrapped: a sample past full scale that wrapped would be a
 * click at the loudest moment of somebody's sound.
 */
export function encodeWav(
    samples: Float32Array,
    sampleRate: number = SOUND_SAMPLE_RATE
): Uint8Array {
    const pcm = new Uint8Array(samples.length * 2);
    const view = new DataView(pcm.buffer);
    for (let index = 0; index < samples.length; index += 1) {
        const value = Math.max(-1, Math.min(1, samples[index] ?? 0));
        view.setInt16(index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    }
    return wavBytes(pcm, 1, sampleRate);
}
