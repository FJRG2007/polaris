/**
 * Voice mode as a state machine: it listens, hears, reads what you said, waits
 * for the answer and says it - and speaking over it, muting and ending each do
 * exactly one thing. Plus the sentences an answer is read back in.
 */

import { describe, expect, it } from "vitest";
import {
    acceptedAudioType,
    callReducer,
    INITIAL_CALL,
    micOpen,
    readySentences,
    SPEAK_TEXT_MAX,
    type CallEvent,
    type CallState
} from "@/lib/polar/voice-call";

const run = (events: CallEvent[], from: CallState = INITIAL_CALL) =>
    events.reduce(callReducer, from);

describe("the voice call", () => {
    it("goes round one whole turn", () => {
        let state = run([{ type: "speech-start" }]);
        expect(state.phase).toBe("hearing");
        state = run([{ type: "speech-end" }], state);
        expect(state.phase).toBe("transcribing");
        expect(micOpen(state)).toBe(false);
        state = run([{ type: "transcribed", text: "  what's on today?  " }], state);
        expect(state).toMatchObject({ phase: "thinking", heard: "what's on today?", reply: "" });
        state = run([{ type: "reply", text: "Two meetings." }, { type: "speaking" }], state);
        expect(state).toMatchObject({ phase: "speaking", reply: "Two meetings." });
        state = run([{ type: "reply-done" }], state);
        expect(state.phase).toBe("listening");
        expect(micOpen(state)).toBe(true);
    });

    it("goes back to listening when nothing was said", () => {
        const state = run([
            { type: "speech-start" },
            { type: "speech-end" },
            { type: "transcribed", text: "   " }
        ]);
        expect(state.phase).toBe("listening");
        expect(state.heard).toBe("");
    });

    it("stops talking when you speak over it", () => {
        const speaking = run([
            { type: "speech-start" },
            { type: "speech-end" },
            { type: "transcribed", text: "tell me a story" },
            { type: "speaking" }
        ]);
        const interrupted = callReducer(speaking, { type: "speech-start" });
        expect(interrupted.phase).toBe("hearing");
        expect(interrupted.interruptions).toBe(1);
        const whileThinking = run([
            { type: "speech-start" },
            { type: "speech-end" },
            { type: "transcribed", text: "hi" },
            { type: "speech-start" }
        ]);
        expect(whileThinking.interruptions).toBe(1);
    });

    it("does not count your voice as an interruption while it reads you", () => {
        const reading = run([{ type: "speech-start" }, { type: "speech-end" }]);
        expect(callReducer(reading, { type: "speech-start" })).toBe(reading);
    });

    it("drops a sentence cut off by mute, and ignores the microphone while muted", () => {
        const hearing = run([{ type: "speech-start" }]);
        const muted = callReducer(hearing, { type: "mute" });
        expect(muted).toMatchObject({ muted: true, phase: "listening", discarded: 1 });
        expect(micOpen(muted)).toBe(false);
        expect(callReducer(muted, { type: "speech-start" })).toBe(muted);
        const back = callReducer(muted, { type: "unmute" });
        expect(back.muted).toBe(false);
        expect(callReducer(back, { type: "speech-start" }).phase).toBe("hearing");
    });

    it("keeps talking when muted while it speaks", () => {
        const speaking = run([
            { type: "speech-start" },
            { type: "speech-end" },
            { type: "transcribed", text: "hi" },
            { type: "speaking" },
            { type: "mute" }
        ]);
        expect(speaking).toMatchObject({ phase: "speaking", muted: true, discarded: 0 });
    });

    it("waits for an approval with the microphone closed", () => {
        const waiting = run([
            { type: "speech-start" },
            { type: "speech-end" },
            { type: "transcribed", text: "delete the task" },
            { type: "approval" }
        ]);
        expect(waiting.phase).toBe("approval");
        expect(micOpen(waiting)).toBe(false);
        expect(callReducer(waiting, { type: "speech-start" })).toBe(waiting);
        expect(callReducer(waiting, { type: "approved" }).phase).toBe("thinking");
    });

    it("shows a failure and listens again; a missing voice keeps the answer going", () => {
        const failed = run([
            { type: "speech-start" },
            { type: "speech-end" },
            { type: "failed", error: "transcribe_failed" }
        ]);
        expect(failed).toMatchObject({ phase: "listening", error: "transcribe_failed" });
        expect(callReducer(failed, { type: "speech-start" }).error).toBeNull();
        const thinking = run([
            { type: "speech-start" },
            { type: "speech-end" },
            { type: "transcribed", text: "hi" }
        ]);
        expect(callReducer(thinking, { type: "failed", error: "speak_failed" })).toMatchObject({
            phase: "thinking",
            error: "speak_failed"
        });
    });

    it("listens again when no key can hear you, instead of staying on transcribing", () => {
        const heard = run([{ type: "speech-start" }, { type: "speech-end" }]);
        expect(heard.phase).toBe("transcribing");
        for (const error of ["no_voice_provider", "no_speech_provider", "speak_failed"] as const) {
            const failed = callReducer(heard, { type: "failed", error });
            expect(failed).toMatchObject({ phase: "listening", error });
            expect(micOpen(failed)).toBe(true);
        }
    });

    it("ignores everything once ended", () => {
        const ended = run([{ type: "speech-start" }, { type: "end" }]);
        expect(ended.ended).toBe(true);
        expect(micOpen(ended)).toBe(false);
        expect(callReducer(ended, { type: "speech-end" })).toBe(ended);
        expect(callReducer(ended, { type: "unmute" })).toBe(ended);
    });

    it("starts listening, unmuted", () => {
        expect(INITIAL_CALL).toMatchObject({ phase: "listening", muted: false, ended: false });
    });
});

describe("the sentences an answer is read in", () => {
    it("says each sentence as soon as it ends, and the rest when the answer is done", () => {
        const first = readySentences("Hello there. How are", 0, false);
        expect(first.sentences).toEqual(["Hello there."]);
        const second = readySentences("Hello there. How are you? Fine", first.upTo, false);
        expect(second.sentences).toEqual(["How are you?"]);
        const last = readySentences("Hello there. How are you? Fine", second.upTo, true);
        expect(last.sentences).toEqual(["Fine"]);
        expect(last.upTo).toBe("Hello there. How are you? Fine".length);
    });

    it("does not end a sentence inside a number still streaming", () => {
        expect(readySentences("It costs 2.", 0, false).sentences).toEqual([]);
        expect(readySentences("It costs 2.5 euros. Ok", 0, false).sentences).toEqual([
            "It costs 2.5 euros."
        ]);
    });

    it("reads Markdown as words, and skips code", () => {
        const { sentences } = readySentences(
            "## Plan\n\n- **Open** [the page](https://example.test).\n\n```sh\nrm -rf /\n```\n\nDone.",
            0,
            true
        );
        expect(sentences).toEqual(["Plan", "Open the page.", "Done."]);
    });

    it("cuts a sentence too long for one request", () => {
        const long = `${"word ".repeat(200)}end`;
        const { sentences } = readySentences(long, 0, false);
        expect(sentences.length).toBeGreaterThan(0);
        for (const sentence of sentences)
            expect(sentence.length).toBeLessThanOrEqual(SPEAK_TEXT_MAX);
    });
});

describe("the recordings the route accepts", () => {
    it("takes what browsers record, with or without codecs", () => {
        expect(acceptedAudioType("audio/webm;codecs=opus")).toBe("audio/webm");
        expect(acceptedAudioType("audio/mp4")).toBe("audio/mp4");
        expect(acceptedAudioType("image/png")).toBeNull();
        expect(acceptedAudioType(null)).toBeNull();
    });
});
