/**
 * A sound's file, and the pass a play carries.
 *
 * The server keeps only plain 16-bit PCM WAV of at most 512 KB and 5.2
 * seconds, re-read from its own chunks and stored under a clean header. A pass
 * opens one sound in one call for a while, and nothing else.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "test-secret-not-real" })
}));

const { encodeWav, readWav, SOUND_SAMPLE_RATE } = await import("@/lib/chat/sound-file");
const { readSoundTicket, soundTicket, soundUrl } = await import("@/lib/chat/soundboard-ticket");
const { soundPlayedSchema } = await import("@/lib/chat/soundboard");

const seconds = (value: number) => new Float32Array(Math.round(SOUND_SAMPLE_RATE * value)).fill(0.25);

describe("a sound's file", () => {
    it("is read back with its length", () => {
        const file = readWav(encodeWav(seconds(1)));
        expect(file.ok && file.durationMs).toBe(1000);
    });

    it("is refused past 5.2 seconds", () => {
        const file = readWav(encodeWav(new Float32Array(22_050 * 6).fill(0), 22_050));
        expect(file).toEqual({ ok: false, problem: "length" });
    });

    it("is refused past 512 KB, before anything is parsed", () => {
        expect(readWav(new Uint8Array(512 * 1024 + 1))).toEqual({ ok: false, problem: "size" });
    });

    it("is refused empty, or when it is not a WAV at all", () => {
        expect(readWav(new Uint8Array())).toEqual({ ok: false, problem: "empty" });
        expect(readWav(new TextEncoder().encode("ID3".padEnd(64, "x")))).toEqual({
            ok: false,
            problem: "type"
        });
    });

    it("loses whatever an editor put around the samples", () => {
        const plain = encodeWav(seconds(0.1));
        // A `LIST` chunk between the format and the samples.
        const extra = new Uint8Array([..."LIST"].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0, 1, 2, 3, 4]));
        const tagged = new Uint8Array(plain.length + extra.length);
        tagged.set(plain.subarray(0, 36));
        tagged.set(extra, 36);
        tagged.set(plain.subarray(36), 36 + extra.length);
        const file = readWav(tagged);
        expect(file.ok && file.canonical).toEqual(plain);
    });

    it("of 5.2 seconds fits in 512 KB at the rate the browser writes", () => {
        expect(encodeWav(seconds(5.2)).length).toBeLessThanOrEqual(512 * 1024);
    });
});

describe("a play's pass", () => {
    const sound = "0193b0f0-0000-7000-8000-0000000000c1";
    const call = "0193b0f0-0000-7000-8000-0000000000e1";
    const now = 1_800_000_000_000;

    it("opens that sound in that call", () => {
        expect(readSoundTicket(soundTicket(sound, call, now), sound, call, now)).toBe(true);
    });

    it("opens nothing in another call, or another sound", () => {
        const pass = soundTicket(sound, call, now);
        expect(readSoundTicket(pass, sound, "0193b0f0-0000-7000-8000-0000000000e2", now)).toBe(false);
        expect(readSoundTicket(pass, "0193b0f0-0000-7000-8000-0000000000c2", call, now)).toBe(false);
    });

    it("runs out", () => {
        expect(readSoundTicket(soundTicket(sound, call, now), sound, call, now + 11 * 60_000)).toBe(
            false
        );
    });

    it("is refused when tampered with", () => {
        const [expires, signature] = soundTicket(sound, call, now).split(".");
        expect(readSoundTicket(`${Number(expires) + 1}.${signature}`, sound, call, now)).toBe(false);
        expect(readSoundTicket("garbage", sound, call, now)).toBe(false);
    });

    it("travels in an address the browsers accept", () => {
        const played = {
            kind: "sound",
            id: crypto.randomUUID(),
            from: crypto.randomUUID(),
            userId: crypto.randomUUID(),
            sound,
            name: "Drum",
            emoji: "",
            volume: 1,
            url: soundUrl(sound, call)
        };
        expect(soundPlayedSchema.safeParse(played).success).toBe(true);
    });
});
