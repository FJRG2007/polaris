/**
 * The voice sent to a camera's speaker, in the one shape the relay takes it.
 *
 * A Tapo camera plays G.711 A-law at 8 kHz and nothing else. The relay (go2rtc
 * 1.9.14) accepts a pushed stream on `POST /api/stream?dst=` and recognises it
 * by its first bytes; of what it recognises, only WAV can carry A-law - its
 * MPEG-TS reader knows H.264, H.265, AAC and Opus and nothing else. So the
 * browser sends 16-bit PCM at 8 kHz, Polaris encodes it here, and the relay
 * hands the A-law to the camera untouched: no transcoder anywhere.
 *
 * Pure, so the bytes can be asserted in a test, and safe for a browser: the
 * screen brings its microphone down to the talk rate with the resampler here.
 */

/** Samples a second, and the only rate the camera plays. */
export const TALK_RATE = 8000;

/** The most PCM one push may carry: one second of 16-bit mono. */
export const MAX_CHUNK_BYTES = TALK_RATE * 2;

/** One 16-bit linear sample to G.711 A-law (ITU-T G.711, segment encoding). */
export function alawSample(sample: number): number {
    let pcm = Math.max(-32768, Math.min(32767, Math.trunc(sample))) >> 3;
    let mask: number;
    if (pcm >= 0) mask = 0xd5;
    else {
        mask = 0x55;
        pcm = -pcm - 1;
    }
    const ends = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
    let segment = ends.findIndex((end) => pcm <= end);
    if (segment < 0) return 0x7f ^ mask;
    const value = segment < 2 ? (pcm >> 1) & 0x0f : (pcm >> segment) & 0x0f;
    return ((segment << 4) | value) ^ mask;
}

/** Little-endian 16-bit PCM to A-law, one byte per sample. An odd trailing
 *  byte is dropped rather than read as half a sample. */
export function encodeAlaw(pcm: Uint8Array): Uint8Array {
    const samples = Math.floor(pcm.byteLength / 2);
    const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
    const out = new Uint8Array(samples);
    for (let i = 0; i < samples; i++) out[i] = alawSample(view.getInt16(i * 2, true));
    return out;
}

/**
 * The header of a WAV with no end: A-law, mono, 8 kHz, with the sizes left at
 * their maximum the way go2rtc writes its own live WAV. The relay reads the
 * format from the `fmt ` chunk and then reads samples until the push closes.
 */
export function liveWavHeader(): Uint8Array {
    const header = new Uint8Array(46);
    const view = new DataView(header.buffer);
    const ascii = (at: number, text: string) => {
        for (let i = 0; i < text.length; i++) header[at + i] = text.charCodeAt(i);
    };
    ascii(0, "RIFF");
    view.setUint32(4, 0xffffffff, true);
    ascii(8, "WAVEfmt ");
    view.setUint32(16, 18, true); // fmt chunk: 16 bytes plus the extra-size field
    view.setUint16(20, 6, true); // 6 = A-law
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, TALK_RATE, true);
    view.setUint32(28, TALK_RATE, true); // bytes a second: one byte a sample
    view.setUint16(32, 1, true); // block align
    view.setUint16(34, 8, true); // bits a sample
    view.setUint16(36, 0, true); // no extra format bytes
    ascii(38, "data");
    view.setUint32(42, 0xffffffff, true);
    return header;
}

/** The relay's name for the stream a camera's talk is pushed into. */
export function talkStreamName(cameraId: string): string {
    return `${cameraId}-talk`;
}

/**
 * The microphone, at whatever rate the browser records, brought down to
 * 16-bit little-endian PCM at `TALK_RATE` - what the talk route takes.
 *
 * Each output sample is the mean of the input samples it covers, which is the
 * low-pass a voice needs before it loses five sixths of its samples. Stateful
 * across pieces, so a rate that does not divide evenly (44.1 kHz) carries its
 * remainder into the next piece instead of clicking at every boundary.
 */
export class TalkResampler {
    private readonly ratio: number;
    private position = 0;
    private sum = 0;
    private count = 0;

    constructor(inputRate: number) {
        this.ratio = Math.max(1, inputRate / TALK_RATE);
    }

    push(input: Float32Array): Uint8Array {
        const out = new Uint8Array(Math.ceil(input.length / this.ratio + 1) * 2);
        const view = new DataView(out.buffer);
        let written = 0;
        for (const sample of input) {
            this.sum += sample;
            this.count += 1;
            this.position += 1;
            if (this.position < this.ratio) continue;
            this.position -= this.ratio;
            const mean = Math.max(-1, Math.min(1, this.sum / this.count));
            view.setInt16(written, Math.round(mean * 32767), true);
            written += 2;
            this.sum = 0;
            this.count = 0;
        }
        return out.subarray(0, written);
    }
}
