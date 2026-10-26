/**
 * The decisions behind the composer's mic, with nothing in them that needs a
 * browser: which button sits at the end of the box, what a press on the mic
 * means, which engine turns speech into text, and which attach actions a room
 * allows. Kept apart from the components so each one can be asserted on its own.
 */

import type { NamespaceKey } from "@/lib/i18n/types";

/** How long a press is held before it is a hold rather than a tap. Long enough
 *  that a quick tap never starts a voice message, short enough that holding
 *  does not feel like waiting. */
export const HOLD_MS = 350;

/** A hold released sooner than this after the recording began is a slip, not a
 *  message: it is thrown away rather than sent as a click of silence. */
export const SHORTEST_VOICE_MS = 1000;

/** How far a held press slides before it means something. */
export const SLIDE_CANCEL_PX = 80;
export const SLIDE_LOCK_PX = 60;

/** What the end of the box offers: the mic for an empty box, Send for anything
 *  that can go, and both while dictation runs into a box that has text. */
export type ComposerSlot = "mic" | "send" | "both";

export function composerSlot(state: {
    /** Rewriting a message, which always ends in saving it. */
    editing: boolean;
    /** No text that would be sent. */
    blank: boolean;
    /** Files waiting to go with the message. */
    staged: boolean;
    /** Whether there is a mic to offer at all - dictation or a voice message. */
    micAvailable: boolean;
    /** Whether dictation is running now. */
    dictating: boolean;
}): ComposerSlot {
    if (state.editing || !state.micAvailable) return "send";
    if (state.dictating) return state.blank && !state.staged ? "mic" : "both";
    return state.blank && !state.staged ? "mic" : "send";
}

/** The two ways speech becomes text: the browser's own recognizer, or Polaris's
 *  transcription of the recording. */
export type DictationEngine = "browser" | "private";

export function dictationEngine(available: {
    browser: boolean;
    private: boolean;
    /** The "Private dictation" switch. */
    preferPrivate: boolean;
}): DictationEngine | null {
    if (available.private && (available.preferPrivate || !available.browser)) return "private";
    if (available.browser) return "browser";
    return null;
}

/** What one press on the mic does. Null is nothing to do, which the caller
 *  never draws a button for. */
export type MicAction = "dictate" | "voice" | null;

/** A tap: dictation where there is an engine, a voice message where there is
 *  not, so the mic is never a dead button. */
export function tapAction(state: {
    engine: DictationEngine | null;
    voiceAllowed: boolean;
}): MicAction {
    if (state.engine) return "dictate";
    return state.voiceAllowed ? "voice" : null;
}

/** A hold: a voice message, where one may be sent; otherwise the same as a tap. */
export function holdAction(state: {
    engine: DictationEngine | null;
    voiceAllowed: boolean;
}): MicAction {
    if (state.voiceAllowed) return "voice";
    return tapAction(state);
}

/** Whether a press lasted long enough to be a hold. */
export function isHold(downAt: number, upAt: number): boolean {
    return upAt - downAt >= HOLD_MS;
}

/** What sliding a held press means: left throws the recording away, up keeps it
 *  going without the finger. Left wins when both are past, since cancelling is
 *  the one that has to be possible in a hurry. */
export function slideOutcome(dx: number, dy: number): "cancel" | "lock" | null {
    if (dx <= -SLIDE_CANCEL_PX) return "cancel";
    if (dy <= -SLIDE_LOCK_PX) return "lock";
    return null;
}

/** An attach action in the "+" menu. */
export type AttachItem = "file" | "gallery" | "camera" | "clip" | "poll" | "mic";

/**
 * The attach actions a box offers, in the order they are listed. Gone rather
 * than disabled where the room does not allow them - a dead item is a promise
 * the room cannot keep - with the same rules the separate buttons had.
 */
export function attachItems(room: {
    /** Files may be sent here at all. */
    mayAttach: boolean;
    /** A phone or tablet, which is where a camera item opens a camera. */
    handheld: boolean;
    /** The browser can share a screen to record a clip. */
    clippable: boolean;
    inCall: boolean;
    /** There is somewhere for a poll to go. */
    poll: boolean;
    /** A mic menu to reach. Listed here only on a phone, which has no chevron
     *  beside the mic. */
    micMenu: boolean;
}): AttachItem[] {
    const items: AttachItem[] = [];
    if (room.mayAttach) items.push("file", "gallery");
    if (room.mayAttach && room.handheld) items.push("camera");
    if (room.mayAttach && room.clippable && !room.inCall) items.push("clip");
    if (room.poll) items.push("poll");
    if (room.micMenu && room.handheld) items.push("mic");
    return items;
}

/** Why dictation stopped, as a code the screen has a sentence for. */
export type DictationProblem =
    | "micBlocked"
    | "serviceBlocked"
    | "noSpeech"
    | "network"
    | "noMic"
    | "language"
    | "notSetUp"
    | "tooMany"
    | "failed";

/** The sentence for each problem. */
export const PROBLEM_KEYS: Readonly<Record<DictationProblem, NamespaceKey<"chat">>> = {
    micBlocked: "dictation.problem.micBlocked",
    serviceBlocked: "dictation.problem.serviceBlocked",
    noSpeech: "dictation.problem.noSpeech",
    network: "dictation.problem.network",
    noMic: "dictation.problem.noMic",
    language: "dictation.problem.language",
    notSetUp: "dictation.problem.notSetUp",
    tooMany: "dictation.problem.tooMany",
    failed: "dictation.problem.failed"
};

/** The sentences that point at the "Private dictation" switch, for a mic menu
 *  that has it. */
export const PRIVATE_SWITCH_KEYS: Readonly<
    Partial<Record<DictationProblem, NamespaceKey<"chat">>>
> = {
    serviceBlocked: "dictation.problemWithPrivate.serviceBlocked",
    network: "dictation.problemWithPrivate.network",
    language: "dictation.problemWithPrivate.language",
    notSetUp: "dictation.problemWithPrivate.notSetUp"
};

/** The sentence for a problem, naming the switch only where it is on screen. */
export function problemKey(
    problem: DictationProblem,
    privateSwitch: boolean
): NamespaceKey<"chat"> {
    return (privateSwitch ? PRIVATE_SWITCH_KEYS[problem] : undefined) ?? PROBLEM_KEYS[problem];
}

/**
 * A browser recognizer's error as a problem, or null for one that is not worth
 * a sentence (a stop somebody asked for). The codes are the ones
 * `SpeechRecognitionErrorEvent.error` lists on MDN.
 */
export function browserProblem(code: string): DictationProblem | null {
    switch (code) {
        case "aborted":
            return null;
        case "not-allowed":
            return "micBlocked";
        case "service-not-allowed":
            return "serviceBlocked";
        case "no-speech":
            return "noSpeech";
        case "network":
            return "network";
        case "audio-capture":
            return "noMic";
        case "language-not-supported":
            return "language";
        default:
            return "failed";
    }
}

/** Polaris's transcription error codes as problems. */
export function privateProblem(code: string): DictationProblem {
    if (code === "no_voice_provider") return "notSetUp";
    if (code === "rate_limited" || code === "usage_limit") return "tooMany";
    return "failed";
}

/** How long a pause ends a chunk of private dictation, and the longest one
 *  chunk may run before it is sent anyway. */
export const PAUSE_MS = 900;
export const LONGEST_CHUNK_MS = 20_000;

/** Whether the private engine should send what it has heard so far. */
export function chunkReady(state: { heard: boolean; quietMs: number; chunkMs: number }): boolean {
    if (!state.heard) return false;
    return state.quietMs >= PAUSE_MS || state.chunkMs >= LONGEST_CHUNK_MS;
}

/** What the browser recognizer is asked to listen for: the reader's UI
 *  language, which is a BCP 47 tag already. */
export function speechLang(locale: string): string {
    return locale || "en-US";
}

const HINT_KEY = "polaris.chat.dictation-hint";
const PRIVATE_KEY = "polaris.chat.dictation-private";

/** Whether the "tap to dictate, hold for a voice message" hint was seen in
 *  this browser. Unreadable storage counts as seen, so a hint that cannot be
 *  remembered is not shown on every visit. */
export function dictationHintSeen(): boolean {
    try {
        return window.localStorage.getItem(HINT_KEY) === "1";
    } catch {
        return true;
    }
}

export function markDictationHintSeen(): void {
    try {
        window.localStorage.setItem(HINT_KEY, "1");
    } catch {
        // Shown again next time; nothing else depends on it.
    }
}

/** The "Private dictation" switch, per browser like the other mic settings. */
export function privateDictation(): boolean {
    try {
        return window.localStorage.getItem(PRIVATE_KEY) === "1";
    } catch {
        return false;
    }
}

export function setPrivateDictation(on: boolean): void {
    try {
        if (on) window.localStorage.setItem(PRIVATE_KEY, "1");
        else window.localStorage.removeItem(PRIVATE_KEY);
    } catch {
        // Applies to this visit only.
    }
}
