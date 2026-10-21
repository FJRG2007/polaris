/**
 * Speaking with Polar: the limits both ends agree on, the reply cut into
 * sentences it can say as soon as each one is written, and the voice call as a
 * pure state machine.
 *
 * The call follows the shape Open WebUI's voice mode settled on
 * (docs.openwebui.com/features/chat-conversations/chat-features/voice-mode):
 * it listens until it hears you, sends what you said after a pause, reads the
 * answer back one sentence at a time while it streams, and stops talking the
 * moment you speak over it. Muting in the middle of a sentence drops that
 * sentence rather than sending half of it.
 *
 * Client-safe: no server imports.
 */

import { z } from "zod";
import { transcriptionChoiceSchema, type TranscriptionOption } from "@/lib/polar/transcription";
import { PAYERS } from "@/lib/polar/shared";

/** Largest recording the transcription route takes. Five minutes of Opus is a
 *  couple of megabytes; this leaves room for Safari's MP4. */
export const VOICE_AUDIO_MAX_BYTES = 8 * 1024 * 1024;

/** Longest recording, in seconds - the same ceiling a Chat voice message has. */
export const VOICE_MAX_SECONDS = 300;

/** Longest piece of text spoken in one request: a sentence, or a long one cut. */
export const SPEAK_TEXT_MAX = 600;

/** The containers a browser records into, as the route accepts them. */
const AUDIO_TYPES = ["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg", "audio/wav"] as const;

/** The base type of an accepted recording, or null. Parameters such as
 *  `;codecs=opus` are allowed and dropped. */
export function acceptedAudioType(header: string | null): string | null {
    const base = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    return (AUDIO_TYPES as readonly string[]).includes(base) ? base : null;
}

/** The query of a transcription: how long the browser says it recorded for. */
export const transcribeQuerySchema = z.object({
    durationMs: z.coerce
        .number()
        .int()
        .min(0)
        .max(VOICE_MAX_SECONDS * 1000),
    /** Who pays, as picked for the chat; absent means the usual order. */
    payer: z.enum(PAYERS).nullable().default(null),
    /** The model picked in the mic menu (`provider/model`); absent means the
     *  stored pick. One whose key is gone falls back to the fastest held. */
    model: transcriptionChoiceSchema.optional()
});

/** The body of a speech request. */
export const speakBodySchema = z.object({
    text: z.string().trim().min(1).max(SPEAK_TEXT_MAX),
    payer: z.enum(PAYERS).nullable().default(null),
    /** The language to say it in (a BCP 47 tag such as `es-ES`); a voice that
     *  cannot speak it is skipped. Absent from an older page: any voice. */
    lang: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/)
        .nullable()
        .default(null)
});

/** What this person can do with their voice, carried on `/api/polar/models`. */
export interface VoiceAvailability {
    /** Speech to text: dictation, and hearing you in a call. */
    dictation: boolean;
    /** Text to speech: the call's spoken answers. */
    speech: boolean;
    /** Every model a key is held for, for the mic menu. */
    transcribers: TranscriptionOption[];
    /** The one in use: the pick, or the fastest held. */
    transcriber: string | null;
}

export const NO_VOICE: VoiceAvailability = {
    dictation: false,
    speech: false,
    transcribers: [],
    transcriber: null
};

/** Markdown that reads badly out loud: code, links, emphasis, list markers. */
function speakable(text: string): string {
    return text
        .replace(/```[\s\S]*?(```|$)/g, " ")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, "")
        .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
        .replace(/\|/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Where the next sentence of `text` ends, or -1 when it has not ended yet. A
 *  full stop that is part of a number ("2.5") is not an end. */
function sentenceEnd(text: string): number {
    const pattern = /[.!?。！？]+(?=\s|$)|\n\s*\n/g;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const end = match.index + match[0].length;
        // At the very end of what has streamed so far, a full stop may still be
        // a decimal point waiting for its digits.
        if (end === text.length && /\d\.$/.test(text)) continue;
        return end;
    }
    return -1;
}

/**
 * The sentences of a reply that are ready to be said, and how far into the text
 * they reach. `done` says the reply has finished, so whatever is left is the
 * last sentence. A sentence longer than `SPEAK_TEXT_MAX` is cut at a space.
 */
export function readySentences(
    text: string,
    from: number,
    done: boolean
): { sentences: string[]; upTo: number } {
    const sentences: string[] = [];
    let at = from;
    for (;;) {
        const rest = text.slice(at);
        let end = sentenceEnd(rest);
        if (end < 0 && rest.length > SPEAK_TEXT_MAX) {
            const space = rest.lastIndexOf(" ", SPEAK_TEXT_MAX);
            end = space > 0 ? space : SPEAK_TEXT_MAX;
        }
        if (end < 0) {
            if (done && rest.trim()) {
                const said = speakable(rest);
                if (said) sentences.push(said);
                at = text.length;
            }
            break;
        }
        const said = speakable(rest.slice(0, end));
        if (said) sentences.push(said.slice(0, SPEAK_TEXT_MAX));
        at += end;
    }
    return { sentences, upTo: at };
}

/** What the call is doing. */
export type CallPhase =
    /** Waiting to hear you. */
    | "listening"
    /** You are speaking; it is recording. */
    | "hearing"
    /** What you said is being turned into text. */
    | "transcribing"
    /** Polar is working on the answer. */
    | "thinking"
    /** Polar is saying the answer. */
    | "speaking"
    /** A change Polar wants to make is waiting for you. */
    | "approval";

/** A failure the call shows, as a code the screen has words for. */
export type CallError =
    | "mic_denied"
    | "no_voice_provider"
    | "no_speech_provider"
    | "transcribe_failed"
    | "speak_failed";

export interface CallState {
    phase: CallPhase;
    muted: boolean;
    ended: boolean;
    /** What you said last, for the captions. */
    heard: string;
    /** Polar's answer so far, for the captions. */
    reply: string;
    error: CallError | null;
    /** Bumped each time you speak over Polar: playback and the turn stop. */
    interruptions: number;
    /** Bumped each time a recording is dropped (muted mid-sentence). */
    discarded: number;
}

export type CallEvent =
    | { type: "speech-start" }
    | { type: "speech-end" }
    | { type: "transcribed"; text: string }
    | { type: "failed"; error: CallError }
    | { type: "reply"; text: string }
    | { type: "speaking" }
    | { type: "reply-done" }
    | { type: "approval" }
    | { type: "approved" }
    | { type: "mute" }
    | { type: "unmute" }
    | { type: "end" };

export const INITIAL_CALL: CallState = {
    phase: "listening",
    muted: false,
    ended: false,
    heard: "",
    reply: "",
    error: null,
    interruptions: 0,
    discarded: 0
};

/** The call's next state. Pure, so every transition is a test. */
export function callReducer(state: CallState, event: CallEvent): CallState {
    if (state.ended) return state;
    switch (event.type) {
        case "speech-start":
            if (state.muted) return state;
            if (state.phase === "listening") return { ...state, phase: "hearing", error: null };
            // Speaking over Polar stops it, the way you would stop a person.
            if (state.phase === "thinking" || state.phase === "speaking") {
                return {
                    ...state,
                    phase: "hearing",
                    error: null,
                    interruptions: state.interruptions + 1
                };
            }
            return state;
        case "speech-end":
            return state.phase === "hearing" ? { ...state, phase: "transcribing" } : state;
        case "transcribed": {
            if (state.phase !== "transcribing") return state;
            const text = event.text.trim();
            if (!text) return { ...state, phase: "listening" };
            return { ...state, phase: "thinking", heard: text, reply: "" };
        }
        case "failed":
            // A missing voice still leaves the answer on screen.
            return (event.error === "speak_failed" || event.error === "no_speech_provider") &&
                state.phase !== "transcribing"
                ? { ...state, error: event.error }
                : { ...state, phase: "listening", error: event.error };
        case "reply":
            return state.phase === "thinking" || state.phase === "speaking"
                ? { ...state, reply: event.text }
                : state;
        case "speaking":
            return state.phase === "thinking" ? { ...state, phase: "speaking" } : state;
        case "reply-done":
            return state.phase === "thinking" || state.phase === "speaking"
                ? { ...state, phase: "listening" }
                : state;
        case "approval":
            return state.phase === "thinking" || state.phase === "speaking"
                ? { ...state, phase: "approval" }
                : state;
        case "approved":
            return state.phase === "approval" ? { ...state, phase: "thinking" } : state;
        case "mute":
            if (state.muted) return state;
            // Muted mid-sentence: that sentence is dropped, not half-sent.
            return state.phase === "hearing"
                ? { ...state, muted: true, phase: "listening", discarded: state.discarded + 1 }
                : { ...state, muted: true };
        case "unmute":
            return state.muted ? { ...state, muted: false } : state;
        case "end":
            return { ...state, ended: true };
    }
}

/** Whether the microphone should be listened to in this state: always while
 *  the call is open and not muted, except while a recording is being read or an
 *  approval is waiting. */
export function micOpen(state: CallState): boolean {
    return (
        !state.ended && !state.muted && state.phase !== "transcribing" && state.phase !== "approval"
    );
}
