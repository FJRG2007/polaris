/**
 * Live voice in a Polar chat: a speech-to-speech model that hears you and
 * answers in its own voice, the way ChatGPT's voice mode does, instead of
 * transcribing what you said, writing a reply and reading it out.
 *
 * Which providers can do it, which mode a call opens in, the bodies the routes
 * take, and how what was said becomes messages of the thread. The model has
 * one tool, `ask_polar`: anything that needs Polar's own tools, the web, or
 * the person's data is sent as the next message of the thread, so the full
 * turn runs with every tool and approval it has when typed, and the model
 * reads the answer back. That is the split OpenAI's voice agents guide
 * recommends (a realtime agent in front, a text agent with the tools behind,
 * developers.openai.com/api/docs/guides/voice-agents).
 *
 * Client-safe: no server imports.
 */

import { z } from "zod";

/**
 * Providers with a speech-to-speech model a browser can be connected to on a
 * short-lived secret minted here. Checked against each provider's own docs:
 *
 * - OpenAI: Realtime API, `POST /v1/realtime/client_secrets` mints a secret,
 *   the browser opens WebRTC at `/v1/realtime/calls`; the server cuts its own
 *   unplayed audio when you talk over it, and function calling is supported.
 *
 * Researched, not wired yet (each needs a client of its own):
 * - Google Gemini Live: ephemeral token from `v1beta/auth_tokens`, then a
 *   WebSocket carrying raw 16 kHz PCM in and 24 kHz PCM out, played by the page.
 * - ElevenLabs Agents: a signed URL per agent (`/v1/convai/conversation/
 *   get-signed-url?agent_id=`), so an agent has to exist on the account first.
 */
export const LIVE_VOICE_PROVIDERS = ["openai"] as const;
export type LiveVoiceProvider = (typeof LIVE_VOICE_PROVIDERS)[number];

/**
 * The provider a live call runs on, or null. Only a key of the person's own
 * counts: the deployment's key is never handed to a browser, not even as a
 * secret that lasts a minute.
 */
export function liveVoiceProvider(sources: ReadonlyMap<string, string>): LiveVoiceProvider | null {
    return LIVE_VOICE_PROVIDERS.find((slug) => sources.get(slug) === "own") ?? null;
}

/** How voice mode runs for this person: `live` speech to speech, `transcribed`
 *  (what you say is written, the answer read out), or `none`. */
export type VoiceModeKind = "live" | "transcribed" | "none";

export function voiceModeOf(voice: { dictation: boolean; realtime?: boolean }): VoiceModeKind {
    if (voice.realtime) return "live";
    return voice.dictation ? "transcribed" : "none";
}

/** Opening a live call on a chat (`/api/polar/voice/live`). */
export const liveBodySchema = z
    .object({
        threadId: z.string().uuid(),
        lang: z.string().trim().max(35).nullable().default(null)
    })
    .strict();

/** Longest line of a live call saved into the thread. */
export const LIVE_LINE_MAX = 8_000;

const liveLine = z.object({
    id: z.string().trim().min(1).max(64),
    text: z.string().trim().min(1).max(LIVE_LINE_MAX)
});

/** One exchange of a live call, saved into the thread (`/api/polar/voice/live/turn`). */
export const liveTurnBodySchema = z
    .object({
        threadId: z.string().uuid(),
        /** The message the exchange follows, or null at the start of a thread. */
        parentId: z.string().trim().min(1).max(64).nullable().default(null),
        /** A new chat made temporary: kept that way when the call starts it. */
        temporary: z.boolean().default(false),
        user: liveLine,
        assistant: liveLine
    })
    .strict();

export type LiveTurnBody = z.infer<typeof liveTurnBodySchema>;

/** The one tool of a live call. */
export const ASK_POLAR_TOOL = "ask_polar";

/** Longest answer handed back to the voice model to read. */
export const ASK_POLAR_ANSWER_MAX = 6_000;

/** `ask_polar`'s arguments, as the model sends them. */
export const askPolarArgsSchema = z.object({ request: z.string().trim().min(1).max(4_000) });

/** What a live call heard and said, in the order it happened. */
export type LiveEvent =
    /** What you said, transcribed. */
    | { type: "heard"; text: string }
    /** A reply finished: `direct`, an answer of its own; `call`, it called
     *  `ask_polar`; `reading`, it read that answer out. A delegated exchange is
     *  in the thread already, as a typed turn. */
    | { type: "said"; text: string; via: "direct" | "call" | "reading" };

export interface LiveLedger {
    /** What you said that no reply has answered yet. */
    heard: string[];
    /** A reply that came before the transcript of what it answered. */
    said: string | null;
    /** A delegated reply came first: the next transcript is that request's. */
    skipNext: boolean;
}

export const EMPTY_LEDGER: LiveLedger = { heard: [], said: null, skipNext: false };

/**
 * Pairs what you said with what the model answered, so each exchange is saved
 * as a question and its reply. The transcript of what you said can land after
 * the reply (it is written separately), so either side may wait for the other.
 * An exchange that went through `ask_polar` is not saved here: the request and
 * Polar's answer are already messages of the thread.
 */
export function ledgerStep(
    ledger: LiveLedger,
    event: LiveEvent
): { ledger: LiveLedger; exchange: { user: string; assistant: string } | null } {
    const text = event.text.trim();
    if (event.type === "heard") {
        if (!text) return { ledger, exchange: null };
        if (ledger.skipNext) return { ledger: { ...ledger, skipNext: false }, exchange: null };
        if (ledger.said !== null) {
            return { ledger: { heard: [], said: null, skipNext: false }, exchange: { user: text, assistant: ledger.said } };
        }
        return { ledger: { ...ledger, heard: [...ledger.heard, text] }, exchange: null };
    }
    if (event.via === "reading") return { ledger, exchange: null };
    if (event.via === "call") {
        // What was heard is the request; one still being written is skipped.
        return { ledger: { heard: [], said: null, skipNext: ledger.heard.length === 0 }, exchange: null };
    }
    if (!text) return { ledger, exchange: null };
    if (ledger.heard.length > 0) {
        return { ledger: { heard: [], said: null, skipNext: false }, exchange: { user: ledger.heard.join(" "), assistant: text } };
    }
    // Said before anything was heard: kept for the transcript on its way, or
    // joined to the reply before it when the model spoke twice.
    return { ledger: { ...ledger, said: ledger.said ? `${ledger.said} ${text}` : text }, exchange: null };
}
