/**
 * Talking into a muted microphone.
 *
 * What is pinned: a sentence counts and a cough does not, the threshold is the
 * line, and the reader is told at most once in a while.
 */

import { describe, expect, it } from "vitest";
import {
    heardSpeech,
    mayWarn,
    SPEECH_FRAMES,
    SPEECH_LEVEL,
    SPEECH_WINDOW,
    WARN_EVERY_MS
} from "@/app/(app)/chat/muted-speech";

const quiet = (count: number) => Array.from({ length: count }, () => 2);

describe("hearing speech on a muted microphone", () => {
    it("hears a sentence: enough loud readings in the window", () => {
        const window = [...quiet(SPEECH_WINDOW - SPEECH_FRAMES), ...Array(SPEECH_FRAMES).fill(30)];
        expect(heardSpeech(window)).toBe(true);
    });

    it("does not hear a single loud reading - a cough, a door", () => {
        expect(heardSpeech([...quiet(SPEECH_WINDOW - 1), 80])).toBe(false);
    });

    it("needs readings at the threshold, not just under it", () => {
        expect(heardSpeech(Array(SPEECH_WINDOW).fill(SPEECH_LEVEL - 1))).toBe(false);
        expect(heardSpeech(Array(SPEECH_FRAMES).fill(SPEECH_LEVEL))).toBe(true);
    });

    it("hears nothing in silence or with no readings", () => {
        expect(heardSpeech([])).toBe(false);
        expect(heardSpeech(quiet(SPEECH_WINDOW))).toBe(false);
    });

    it("counts loud readings anywhere in the window, not only in a row", () => {
        expect(heardSpeech([30, 2, 30, 2, 30, 2, 30, 2])).toBe(true);
    });
});

describe("how often the notice may show", () => {
    it("shows the first time", () => {
        expect(mayWarn(null, 1_000)).toBe(true);
    });

    it("stays quiet until the limit has passed, then shows again", () => {
        expect(mayWarn(10_000, 10_000 + WARN_EVERY_MS - 1)).toBe(false);
        expect(mayWarn(10_000, 10_000 + WARN_EVERY_MS)).toBe(true);
    });
});
