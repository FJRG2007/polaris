/**
 * A live voice call in a Polar chat on Google's Gemini Live, minted here on
 * the person's own Google AI key.
 *
 * The browser never sees the key: `POST v1beta/auth_tokens` mints an
 * ephemeral token (aistudio.google.com/docs/live-api/ephemeral-tokens) that
 * opens one session, within a minute, and carries the whole session setup
 * as `bidiGenerateContentSetup`. No `fieldMask` is sent, which locks every
 * field of it, the way the official SDK (`googleapis/js-genai`,
 * `src/tokens.ts`) builds the request when nothing is left open: the page
 * cannot swap the model, the instructions or the tools.
 *
 * Server-only.
 */

import { z } from "zod";
import { ASK_POLAR_DEFINITION, liveInstructions } from "@/lib/polar/voice-realtime";
import { ASK_POLAR_TOOL, type GeminiLiveSetup, type LiveGrant } from "@/lib/polar/live-voice";

export const GEMINI_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
/** Google's native-audio Live model (aistudio.google.com/docs/live-api/capabilities). */
export const GEMINI_LIVE_MODEL = "gemini-3.8-live";
export const GEMINI_LIVE_VOICE = "Kore";
/** How long the token may be used to open the session. */
const OPEN_SECONDS = 60;
/** How long a session opened on it, reconnects included, may use it. */
const TOKEN_SECONDS = 30 * 60;
const MINT_TIMEOUT_MS = 15_000;

/** The session setup the token is locked to. */
export function geminiLiveSetup(lang: string | null): GeminiLiveSetup {
    return {
        model: `models/${GEMINI_LIVE_MODEL}`,
        generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_LIVE_VOICE } } }
        },
        systemInstruction: { parts: [{ text: liveInstructions(lang) }] },
        tools: [
            {
                functionDeclarations: [
                    {
                        name: ASK_POLAR_TOOL,
                        description: ASK_POLAR_DEFINITION.description,
                        // Gemini's schema subset: type names in capitals, no additionalProperties.
                        parameters: {
                            type: "OBJECT",
                            properties: {
                                request: { type: "STRING", description: "What the person asked, in their words." }
                            },
                            required: ["request"]
                        }
                    }
                ]
            }
        ],
        // Both sides written down, for the screen and the thread.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Talking over the model cuts its answer, and the server says so.
        realtimeInputConfig: {
            automaticActivityDetection: { disabled: false },
            activityHandling: "START_OF_ACTIVITY_INTERRUPTS"
        },
        // A connection lasts about ten minutes: the page reconnects on a handle.
        sessionResumption: {},
        contextWindowCompression: { slidingWindow: {} }
    };
}

const tokenAnswer = z.object({ name: z.string().regex(/^auth_tokens\/[\w.-]{1,512}$/) });

/**
 * An ephemeral token for one Gemini Live call, or null when Google refused or
 * did not answer. The key is only sent to Google and never returned.
 */
export async function mintGeminiLiveToken(input: {
    apiKey: string;
    lang: string | null;
    fetch?: typeof fetch;
    now?: () => number;
}): Promise<Extract<LiveGrant, { provider: "google-ai" }> | null> {
    const now = (input.now ?? Date.now)();
    const setup = geminiLiveSetup(input.lang);
    try {
        const response = await (input.fetch ?? fetch)(GEMINI_TOKENS_URL, {
            method: "POST",
            headers: { "x-goog-api-key": input.apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
                uses: 1,
                expireTime: new Date(now + TOKEN_SECONDS * 1000).toISOString(),
                newSessionExpireTime: new Date(now + OPEN_SECONDS * 1000).toISOString(),
                bidiGenerateContentSetup: setup
            }),
            signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
            cache: "no-store"
        });
        if (!response.ok) {
            // The status only: Google's error body may quote the request.
            console.warn(`polar: Google refused a Gemini Live token (${response.status})`);
            return null;
        }
        const parsed = tokenAnswer.safeParse(await response.json());
        if (!parsed.success) return null;
        return {
            provider: "google-ai",
            token: parsed.data.name,
            setup,
            expiresAt: Math.floor(now / 1000) + OPEN_SECONDS
        };
    } catch (error) {
        console.warn("polar: no Gemini Live token", error instanceof Error ? error.name : "error");
        return null;
    }
}
