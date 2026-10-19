/**
 * Polar's ears and voice: which of this person's keys can turn speech into
 * text and text into speech, and the AI SDK model for each.
 *
 * Only providers whose speech models the AI SDK names are offered, with the
 * model ids its types list (`@ai-sdk/openai`, `@ai-sdk/google`): OpenAI first,
 * then Google. The keys are the ones every other call spends
 * (`model-keys.ts`): the person's own first, then the deployment's when it
 * shares them.
 *
 * Server-only.
 */

import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { SpeechModel, TranscriptionModel } from "ai";
import type { VoiceAvailability } from "@/lib/polar/voice-call";
import { chatCredentialFor, keySourcesFor, type ChatCredential } from "@/lib/agents/model-keys";

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

/** The first voice provider this person holds a key for. */
async function voiceProviderFor(
    userId: string
): Promise<{ provider: VoiceProvider; credential: ChatCredential } | null> {
    const sources = await keySourcesFor(userId);
    for (const provider of VOICE_PROVIDERS) {
        if (!sources.has(provider.slug)) continue;
        const credential = await chatCredentialFor(userId, provider.slug);
        if (credential) return { provider, credential };
    }
    return null;
}

/** What this person can do with their voice in Polar. Both go together today:
 *  every provider here does both. */
export async function polarVoiceAvailability(userId: string): Promise<VoiceAvailability> {
    try {
        const sources = await keySourcesFor(userId);
        const any = VOICE_PROVIDERS.some((provider) => sources.has(provider.slug));
        return { dictation: any, speech: any };
    } catch {
        return { dictation: false, speech: false };
    }
}

/** The transcription model for this person, or null without a provider. */
export async function polarTranscriber(userId: string): Promise<TranscriptionModel | null> {
    const found = await voiceProviderFor(userId);
    if (!found) return null;
    const apiKey = found.credential.secret;
    return found.provider.slug === "openai"
        ? createOpenAI({ apiKey }).transcription(found.provider.transcription)
        : createGoogle({ apiKey }).transcription(found.provider.transcription);
}

export interface PolarSpeaker {
    model: SpeechModel;
    voice: string;
    format: "mp3" | "wav";
    mediaType: string;
}

/** The speech model for this person, or null without a provider. */
export async function polarSpeaker(userId: string): Promise<PolarSpeaker | null> {
    const found = await voiceProviderFor(userId);
    if (!found) return null;
    const apiKey = found.credential.secret;
    const { provider } = found;
    const model =
        provider.slug === "openai"
            ? createOpenAI({ apiKey }).speech(provider.speech)
            : createGoogle({ apiKey }).speech(provider.speech);
    return { model, voice: provider.voice, format: provider.format, mediaType: provider.mediaType };
}
