/**
 * Voice messages, and the two questions the rest of the screen asks about one.
 *
 * A recording is an ordinary attachment, so what decides whether it is drawn as
 * a player or as a paperclip is its content type - and what decides whether the
 * player shows a file name is whether the name is one of ours. Both are used
 * while drawing every message in a conversation, so both are plain functions
 * over what is stored rather than anything that has to be asked.
 */

import { describe, expect, it } from "vitest";
import {
    barsFrom,
    barsOf,
    isPlayable,
    isVoiceMessage,
    spokenLength,
    voiceFileName
} from "@/app/(app)/chat/voice-recorder";

describe("what gets a player", () => {
    it("plays anything that is audio", () => {
        expect(isPlayable("audio/webm;codecs=opus")).toBe(true);
        expect(isPlayable("audio/mpeg")).toBe(true);
        expect(isPlayable("AUDIO/MP4")).toBe(true);
    });

    it("leaves everything else as a file", () => {
        expect(isPlayable("image/png")).toBe(false);
        expect(isPlayable("application/pdf")).toBe(false);
        expect(isPlayable("")).toBe(false);
    });
});

describe("which of them is a recording", () => {
    it("knows one of ours", () => {
        expect(isVoiceMessage("voice-message.webm", "audio/webm;codecs=opus")).toBe(true);
        expect(isVoiceMessage("voice-message.m4a", "audio/mp4")).toBe(true);
    });

    it("keeps the name on a track somebody attached", () => {
        // The same player, but a song has a name worth showing and a recording
        // does not.
        expect(isVoiceMessage("interview-final.mp3", "audio/mpeg")).toBe(false);
        expect(isVoiceMessage("voice-message.webm", "text/plain")).toBe(false);
    });
});

describe("the file it is sent as", () => {
    it.each([
        ["audio/webm;codecs=opus", "voice-message.webm"],
        ["audio/webm", "voice-message.webm"],
        ["audio/mp4", "voice-message.m4a"],
        ["audio/ogg;codecs=opus", "voice-message.ogg"]
    ])("%s is sent as %s", (type, name) => {
        expect(voiceFileName(type)).toBe(name);
    });
});

describe("the shape of it", () => {
    it("scales against its own loudest moment", () => {
        // Somebody who recorded quietly gets a shape, not a hyphen: the tallest
        // bar is always full height and the rest are relative to it.
        expect(barsFrom([0.01, 0.02, 0.04], 3)).toBe("259");
    });

    it("takes the loudest moment in a slice, not the average", () => {
        // A waveform is read as "where did they speak", and averaging speech
        // with the gaps around it draws a flat line.
        expect(barsFrom([0, 1, 0, 0, 0, 0], 2)).toBe("90");
    });

    it("draws silence as silence", () => {
        expect(barsFrom([0, 0, 0, 0], 4)).toBe("0000");
        expect(barsFrom([], 4)).toBe("0000");
    });

    it("stays inside what the server will store", () => {
        const shape = barsFrom(Array.from({ length: 4000 }, () => 0.5), 500);
        expect(shape.length).toBeLessThanOrEqual(64);
        expect(shape).toMatch(/^[0-9]+$/);
    });

    it("reads back the digits it wrote", () => {
        expect(barsOf("0459")).toEqual([0, 4, 5, 9]);
        expect(barsOf(null)).toEqual([]);
        expect(barsOf("")).toEqual([]);
    });
});

describe("how long it is", () => {
    it.each([
        [0, "0:00"],
        [7, "0:07"],
        [60, "1:00"],
        [125, "2:05"],
        [7.9, "0:07"],
        [-3, "0:00"]
    ])("%s seconds reads as %s", (seconds, shown) => {
        expect(spokenLength(seconds)).toBe(shown);
    });
});
