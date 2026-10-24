/**
 * The bytes a camera's speaker is sent. go2rtc reads a pushed WAV's `fmt `
 * chunk and nothing else, and a Tapo plays A-law at 8 kHz only, so a wrong
 * field here is silence on the far side with no error anywhere.
 */

import { describe, expect, it } from "vitest";
import {
    MAX_CHUNK_BYTES,
    alawSample,
    encodeAlaw,
    liveWavHeader,
    talkStreamName
} from "@polaris-app/places/src/lib/talk-audio";

describe("A-law", () => {
    it("matches the G.711 reference values", () => {
        expect(alawSample(0)).toBe(0xd5);
        expect(alawSample(-1)).toBe(0x55);
        expect(alawSample(32767)).toBe(0xaa);
        expect(alawSample(-32768)).toBe(0x2a);
        expect(alawSample(1000)).toBe(0xfa);
        expect(alawSample(-1000)).toBe(0x7a);
    });

    it("clamps what is out of range instead of wrapping", () => {
        expect(alawSample(40000)).toBe(alawSample(32767));
        expect(alawSample(-40000)).toBe(alawSample(-32768));
    });

    it("encodes little-endian PCM one byte a sample and drops a half sample", () => {
        const pcm = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x12]);
        expect([...encodeAlaw(pcm)]).toEqual([0xd5, 0xaa, 0x2a]);
    });

    it("reads a chunk that starts part way into a buffer", () => {
        const backing = new Uint8Array([9, 0xff, 0x7f]);
        expect([...encodeAlaw(backing.subarray(1))]).toEqual([0xaa]);
    });

    it("caps a push at one second", () => {
        expect(MAX_CHUNK_BYTES).toBe(16000);
    });
});

describe("live WAV header", () => {
    const header = liveWavHeader();
    const view = new DataView(header.buffer);
    const text = (at: number, length: number) =>
        String.fromCharCode(...header.subarray(at, at + length));

    it("is what go2rtc's reader takes as A-law, mono, 8 kHz", () => {
        expect(header.byteLength).toBe(46);
        expect(text(0, 4)).toBe("RIFF");
        expect(text(8, 8)).toBe("WAVEfmt ");
        expect(view.getUint32(16, true)).toBe(18);
        expect(view.getUint16(20, true)).toBe(6);
        expect(view.getUint16(22, true)).toBe(1);
        expect(view.getUint32(24, true)).toBe(8000);
        expect(view.getUint32(28, true)).toBe(8000);
        expect(view.getUint16(34, true)).toBe(8);
        expect(text(38, 4)).toBe("data");
    });

    it("has no end", () => {
        expect(view.getUint32(4, true)).toBe(0xffffffff);
        expect(view.getUint32(42, true)).toBe(0xffffffff);
    });
});

describe("talk stream", () => {
    it("is named after the camera id, beside its main and sub streams", () => {
        expect(talkStreamName("cam-1")).toBe("cam-1-talk");
    });
});
