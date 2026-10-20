/**
 * Polar's ears and voice: which of this person's keys can turn speech into
 * text and text into speech, and the AI SDK model for each.
 *
 * Only providers whose speech models the AI SDK names are offered, with the
 * model ids its types list (`@ai-sdk/openai`, `@ai-sdk/google`): OpenAI first,
 * then Google. The keys are the ones every other call spends
 * (`model-keys.ts`): the person's own first, then the deployment's when it
 * shares them, or only the one the person picked to pay for the chat.
 *
 * Server-only.
 */

import type { Payer } from "@/lib/polar/shared";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { SpeechModel, TranscriptionModel } from "ai";
import type { VoiceAvailability } from "@/lib/polar/voice-call";
import type { ChatCredential } from "@/lib/agents/model-keys";
import { polarCredentialFor, polarKeySources } from "@/lib/polar/access";

interface VoiceProvider {
    slug: string;
    transcription: string;
    speech: string;
    voice: string;
    format: "mp3" | "wav";
    mediaType: string;
}

/** Best first. */
const VOICE_PROVIDERS: readonly VoiceProvider[] = [
    {
        slug: "openai",
        transcription: "gpt-4o-mini-transcribe",
        speech: "gpt-4o-mini-tts",
        voice: "alloy",
        format: "mp3",
        mediaType: "audio/mpeg"
    },
    {
        slug: "google-ai",
        transcription: "gemini-3.5-transcribe",
        speech: "gemini-3.8-flash-tts",
        voice: "Kore",
        format: "wav",
        mediaType: "audio/wav"
    }
];

type FoundVoice = { provider: VoiceProvider; credential: ChatCredential };

/** A call asks for every sentence: the provider and key found for one are
 *  reused for the next few seconds instead of read again from the key store. */
const FOUND_TTL_MS = 30_000;
const FOUND_MOST = 1000;
const found = new Map<string, { at: number; value: FoundVoice }>();

/** The first voice provider this person holds a key for, spending only the
 *  payer's key when they picked who pays. */
async function voiceProviderFor(userId: string, payer: Payer | null): Promise<FoundVoice | null> {
    const key = `${userId}:${payer ?? ""}`;
    const now = Date.now();
    const cached = found.get(key);
    if (cached && now - cached.at < FOUND_TTL_MS) return cached.value;
    found.delete(key);
    const sources = await polarKeySources(userId);
    for (const provider of VOICE_PROVIDERS) {
        if (!sources.has(provider.slug)) continue;
        const credential = await polarCredentialFor(userId, provider.slug, payer);
        if (!credential) continue;
        const value = { provider, credential };
        for (const [entry, { at }] of found) {
            if (found.size < FOUND_MOST && now - at < FOUND_TTL_MS) break;
            found.delete(entry);
        }
        found.set(key, { at: now, value });
        return value;
    }
    return null;
}

/** What this person can do with their voice in Polar. Both go together today:
 *  every provider here does both. */
export async function polarVoiceAvailability(userId: string): Promise<VoiceAvailability> {
    try {
        const sources = await polarKeySources(userId);
        const any = VOICE_PROVIDERS.some((provider) => sources.has(provider.slug));
        return { dictation: any, speech: any };
    } catch {
        return { dictation: false, speech: false };
    }
}

/** The transcription model for this person, or null without a provider. */
export async function polarTranscriber(
    userId: string,
    payer: Payer | null = null
): Promise<TranscriptionModel | null> {
    const voice = await voiceProviderFor(userId, payer);
    if (!voice) return null;
    const apiKey = voice.credential.secret;
    return voice.provider.slug === "openai"
        ? createOpenAI({ apiKey }).transcription(voice.provider.transcription)
        : createGoogle({ apiKey }).transcription(voice.provider.transcription);
}

export interface PolarSpeaker {
    model: SpeechModel;
    voice: string;
    format: "mp3" | "wav";
    mediaType: string;
}

/** The speech model for this person, or null without a provider. */
export async function polarSpeaker(
    userId: string,
    payer: Payer | null = null
): Promise<PolarSpeaker | null> {
    const voice = await voiceProviderFor(userId, payer);
    if (!voice) return null;
    const apiKey = voice.credential.secret;
    const { provider } = voice;
    const model =
        provider.slug === "openai"
            ? createOpenAI({ apiKey }).speech(provider.speech)
            : createGoogle({ apiKey }).speech(provider.speech);
    return { model, voice: provider.voice, format: provider.format, mediaType: provider.mediaType };
}
