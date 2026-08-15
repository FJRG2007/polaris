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
import { isPlayable, isVoiceMessage, spokenLength, voiceFileName } from "@/app/(app)/chat/voice-recorder";

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
