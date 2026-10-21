/**
 * Polar's ears and voice: which of this person's keys can turn speech into
 * text and text into speech, and the AI SDK model for each.
 *
 * Hearing: any model in `transcription.ts` a key is held for, the one the
 * person picked (`PolarPreference.transcriptionModel`) or the fastest one.
 * Speaking: only providers whose speech models the AI SDK names, with the
 * model ids its types list (`@ai-sdk/openai`, `@ai-sdk/google`): OpenAI first,
 * then Google. The keys are the ones every other call spends
 * (`model-keys.ts`): the person's own first, then the deployment's when it
 * shares them, or only the one the person picked to pay for the chat.
 *
 * Server-only.
 */

import type { Payer } from "@/lib/polar/shared";
import { prisma } from "@polaris/db";
import { createFal } from "@ai-sdk/fal";
import { createGroq } from "@ai-sdk/groq";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createRevai } from "@ai-sdk/revai";
import { createGladia } from "@ai-sdk/gladia";
import { createMistral } from "@ai-sdk/mistral";
import { createDeepgram } from "@ai-sdk/deepgram";
import { createAssemblyAI } from "@ai-sdk/assemblyai";
import { createElevenLabs } from "@ai-sdk/elevenlabs";
import type { SpeechModel, TranscriptionModel } from "ai";
import type { VoiceAvailability } from "@/lib/polar/voice-call";
import type { KeySource } from "@/lib/agents/model-keys";
import {
    pickTranscription,
    transcriptionChoiceSchema,
    transcriptionOptions,
    type TranscriptionOption
} from "@/lib/polar/transcription";
import type { ChatCredential } from "@/lib/agents/model-keys";
import {
    polarAccessFor,
    polarCredentialFor,
    polarKeySources,
    type PolarAccess
} from "@/lib/polar/access";

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
    const access = await polarAccessFor(userId);
    const sources = await polarKeySources(userId, access);
    for (const provider of VOICE_PROVIDERS) {
        if (!sources.has(provider.slug)) continue;
        const credential = await polarCredentialFor(userId, provider.slug, payer, access);
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

/** The model this person picked to be heard with, or null for the default.
 *  A stored value that no longer reads as a pick is the default too. */
export async function polarTranscriptionChoice(userId: string): Promise<string | null> {
    const row = await prisma.polarPreference.findUnique({
        where: { userId },
        select: { transcriptionModel: true }
    });
    const parsed = transcriptionChoiceSchema.safeParse(row?.transcriptionModel);
    return parsed.success ? parsed.data : null;
}

/** What this person can do with their voice in Polar, and the models they can
 *  be heard with. */
export async function polarVoiceAvailability(
    userId: string,
    access?: PolarAccess
): Promise<VoiceAvailability> {
    try {
        const [sources, chosen] = await Promise.all([
            polarKeySources(userId, access),
            polarTranscriptionChoice(userId)
        ]);
        const transcribers = transcriptionOptions(sources);
        return {
            dictation: transcribers.length > 0,
            speech: VOICE_PROVIDERS.some((provider) => sources.has(provider.slug)),
            transcribers,
            transcriber: pickTranscription(transcribers, chosen)?.id ?? null
        };
    } catch {
        return { dictation: false, speech: false, transcribers: [], transcriber: null };
    }
}

/** The AI SDK transcription model for one catalogue entry. */
export function transcriptionModelFor(
    option: TranscriptionOption,
    apiKey: string
): TranscriptionModel {
    switch (option.provider) {
        case "groq":
            return createGroq({ apiKey }).transcription(option.model);
        case "openai":
            return createOpenAI({ apiKey }).transcription(option.model);
        case "google-ai":
            return createGoogle({ apiKey }).transcription(option.model);
        case "mistral":
            return createMistral({ apiKey }).transcription(option.model);
        case "deepgram":
            return createDeepgram({ apiKey }).transcription(option.model);
        case "elevenlabs":
            return createElevenLabs({ apiKey }).transcription(option.model);
        case "assemblyai":
            return createAssemblyAI({ apiKey }).transcription(option.model);
        case "gladia":
            return createGladia({ apiKey }).transcription();
        case "revai":
            return createRevai({ apiKey }).transcription(
                option.model as Parameters<ReturnType<typeof createRevai>["transcription"]>[0]
            );
        case "fal":
            return createFal({ apiKey }).transcription(option.model);
        default:
            throw new Error(`polar: no transcription factory for ${option.provider}`);
    }
}

/** A transcription model with the key it spends and what to record it as. */
export interface PolarTranscriber {
    model: TranscriptionModel;
    option: TranscriptionOption;
    source: KeySource;
}

/**
 * The transcription model for this person, or null without a key for any.
 * `chosen` is the pick the browser sent; absent, the stored one. Either is
 * honoured only while its key is there; otherwise the fastest model held,
 * trying the next provider when a payer's key is missing for one.
 */
export async function polarTranscriber(
    userId: string,
    payer: Payer | null = null,
    chosen?: string | null
): Promise<PolarTranscriber | null> {
    const access = await polarAccessFor(userId);
    const [sources, stored] = await Promise.all([
        polarKeySources(userId, access),
        chosen === undefined ? polarTranscriptionChoice(userId) : Promise.resolve(chosen)
    ]);
    const options = transcriptionOptions(sources);
    const first = pickTranscription(options, stored);
    if (!first) return null;
    // The pick first, then one model per other provider in the catalogue's order.
    const order = [
        first,
        ...options.filter(
            (option, index) =>
                option.provider !== first.provider &&
                options.findIndex((other) => other.provider === option.provider) === index
        )
    ];
    for (const option of order) {
        const credential = await polarCredentialFor(userId, option.provider, payer, access);
        if (!credential) continue;
        return {
            model: transcriptionModelFor(option, credential.secret),
            option,
            source: credential.source
        };
    }
    return null;
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
