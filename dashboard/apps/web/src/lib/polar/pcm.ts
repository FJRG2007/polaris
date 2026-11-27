/**
 * Raw PCM for a live call that carries audio itself (Gemini Live): the
 * microphone at the audio context's own rate becomes 16-bit little-endian
 * mono at 16 kHz, base64 for the socket, and the model's 24 kHz answer comes
 * back as floats at the context's rate to be played.
 *
 * Linear interpolation, as Google's own Live API web examples resample; speech
 * at these rates needs no more. Pure, so a test can hold it to exact samples.
 */

/** What Gemini Live takes in, and gives back. */
export const LIVE_INPUT_RATE = 16_000;
export const LIVE_OUTPUT_RATE = 24_000;
export const LIVE_INPUT_MIME = `audio/pcm;rate=${LIVE_INPUT_RATE}`;

/** `input` at `from` Hz, resampled to `to` Hz. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
    if (from === to || input.length === 0) return input.slice();
    const length = Math.max(1, Math.round((input.length * to) / from));
    const output = new Float32Array(length);
    const step = from / to;
    for (let index = 0; index < length; index++) {
        const at = index * step;
        const left = Math.floor(at);
        const right = Math.min(left + 1, input.length - 1);
        const weight = at - left;
        const a = input[Math.min(left, input.length - 1)] ?? 0;
        const b = input[right] ?? 0;
        output[index] = a + (b - a) * weight;
    }
    return output;
}

/** Floats in -1..1 as 16-bit little-endian PCM; anything outside is clipped. */
export function floatToPcm16(input: Float32Array): Uint8Array {
    const bytes = new Uint8Array(input.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < input.length; index++) {
        const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
        view.setInt16(index * 2, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
    }
    return bytes;
}

/** 16-bit little-endian PCM as floats in -1..1; a trailing odd byte is dropped. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
    const count = Math.floor(bytes.length / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
    const output = new Float32Array(count);
    for (let index = 0; index < count; index++) output[index] = view.getInt16(index * 2, true) / 0x8000;
    return output;
}

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
    let text = "";
    // In slices: one call with every byte overflows the argument limit.
    for (let start = 0; start < bytes.length; start += CHUNK) {
        text += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
    }
    return btoa(text);
}

/** Bytes of a base64 string, or an empty array when it is not one. */
export function base64ToBytes(text: string): Uint8Array {
    try {
        const raw = atob(text);
        const bytes = new Uint8Array(raw.length);
        for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
        return bytes;
    } catch {
        return new Uint8Array(0);
    }
}

/** One microphone block, ready for `realtimeInput.audio.data`. */
export function microphoneChunk(input: Float32Array, rate: number): string {
    return bytesToBase64(floatToPcm16(resample(input, rate, LIVE_INPUT_RATE)));
}

/** One block of the model's voice, as floats at `rate` for the player. */
export function voiceChunk(data: string, rate: number): Float32Array {
    return resample(pcm16ToFloat(base64ToBytes(data)), LIVE_OUTPUT_RATE, rate);
}
