// @vitest-environment jsdom

/**
 * Saving a recording as a file somebody can open.
 *
 * What is recorded is Opus in a WebM container, which every browser plays and
 * almost no desktop player does. It is converted on the way out rather than
 * stored twice, so the two things worth asserting are that the name matches what
 * is actually in the file - a `.webm` full of MP3 is worse than either - and
 * that the WAV it writes is a WAV.
 *
 * The header especially: it is forty lines of hand-written byte offsets, and one
 * wrong field produces a file that downloads perfectly and opens in nothing.
 * Nobody finds that by trying it once.
 */

import { describe, expect, it } from "vitest";
import { asWav, extensionOf, renamed } from "@/app/(app)/chat/audio-download";

/** jsdom has no Web Audio, and the writer only ever asks a buffer these four
 *  things. */
function buffer(channels: number[][], sampleRate = 48000): AudioBuffer {
    return {
        numberOfChannels: channels.length,
        length: channels[0]?.length ?? 0,
        sampleRate,
        duration: (channels[0]?.length ?? 0) / sampleRate,
        getChannelData: (index: number) => Float32Array.from(channels[index] ?? [])
    } as unknown as AudioBuffer;
}

async function bytes(blob: Blob): Promise<DataView> {
    return new DataView(await blob.arrayBuffer());
}

function text(view: DataView, at: number, length: number): string {
    return Array.from({ length }, (_, index) =>
        String.fromCharCode(view.getUint8(at + index))
    ).join("");
}

describe("naming the saved file", () => {
    it("wears the extension of what is actually inside it", () => {
        expect(renamed("voice-message.webm", "mp3")).toBe("voice-message.mp3");
        expect(renamed("voice-message.m4a", "wav")).toBe("voice-message.wav");
    });

    it("leaves the original alone", () => {
        // Nothing was re-encoded, so nothing about the name is a lie.
        expect(renamed("voice-message.webm", "original")).toBe("voice-message.webm");
    });

    it("copes with a name that has no extension", () => {
        expect(renamed("recording", "mp3")).toBe("recording.mp3");
        expect(renamed(".webm", "mp3")).toBe("audio.mp3");
    });

    it("reads the extension for the menu, and nothing when there is none", () => {
        expect(extensionOf("voice-message.webm")).toBe("webm");
        expect(extensionOf("a.tar.gz")).toBe("gz");
        expect(extensionOf("recording")).toBe("");
    });
});

describe("the WAV it writes", () => {
    it("is a WAV, at the rate the recording was", async () => {
        const view = await bytes(asWav(buffer([[0, 0, 0, 0]], 44100)));

        expect(text(view, 0, 4)).toBe("RIFF");
        expect(text(view, 8, 4)).toBe("WAVE");
        expect(text(view, 12, 4)).toBe("fmt ");
        expect(text(view, 36, 4)).toBe("data");
        // Uncompressed whole-number samples, one channel, 16 bits.
        expect(view.getUint16(20, true)).toBe(1);
        expect(view.getUint16(22, true)).toBe(1);
        expect(view.getUint16(34, true)).toBe(16);
        expect(view.getUint32(24, true)).toBe(44100);
    });

    it("declares its own length, both times", async () => {
        const blob = asWav(buffer([[0, 0, 0]], 48000));
        const view = await bytes(blob);

        // Three mono frames of two bytes. A player reads the second of these to
        // know when to stop, and the first to know the file is not truncated.
        expect(view.getUint32(40, true)).toBe(6);
        expect(view.getUint32(4, true)).toBe(36 + 6);
        expect(blob.size).toBe(44 + 6);
    });

    it("interleaves the channels rather than laying them end to end", async () => {
        const view = await bytes(
            asWav(
                buffer([
                    [1, 1],
                    [-1, -1]
                ])
            )
        );

        expect(view.getUint16(22, true)).toBe(2);
        // Left, right, left, right - a file written channel after channel plays
        // as one ear then the other.
        expect(view.getInt16(44, true)).toBe(0x7fff);
        expect(view.getInt16(46, true)).toBe(-0x8000);
        expect(view.getInt16(48, true)).toBe(0x7fff);
        expect(view.getInt16(50, true)).toBe(-0x8000);
    });

    it("clamps a sample past the line instead of wrapping it", async () => {
        const view = await bytes(asWav(buffer([[2, -2]])));

        // Wrapping turns the loudest moment of a recording into a click, which
        // is the one artefact people notice immediately.
        expect(view.getInt16(44, true)).toBe(0x7fff);
        expect(view.getInt16(46, true)).toBe(-0x8000);
    });
});
