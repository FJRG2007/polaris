/**
 * Polar's ears and voice: which of this person's keys can turn speech into
 * text and text into speech, and the AI SDK model for each.
 *
 * Hearing: any model in `transcription.ts` a key is held for, the one the
 * person picked (`PolarPreference.transcriptionModel`) or the fastest one.
 * Speaking: only providers whose speech models an installed AI SDK package
 * names, with the model ids and voices its docs list: OpenAI, ElevenLabs,
 * Google, Mistral, then the English-only Deepgram and Groq. A voice that only
 * speaks English is skipped for an answer in another language, and with none
 * left the browser says the answer itself (`browser-voice.ts`). The keys are
 * the ones every other call spends
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

export interface VoiceProvider {
    slug: string;
    voice: string;
    format: "mp3" | "wav";
    mediaType: string;
    /** The languages its voice speaks (primary subtags), or every one. */
    languages: "any" | readonly string[];
    model: (apiKey: string) => SpeechModel;
}

/** Groq's OpenAI-compatible speech endpoint and its English model
 *  (console.groq.com/docs/text-to-speech); `@ai-sdk/groq` has no speech model. */
const GROQ_OPENAI_BASE = "https://api.groq.com/openai/v1";

/** Best first: natural multilingual voices, then the English-only ones. */
export const VOICE_PROVIDERS: readonly VoiceProvider[] = [
    {
        slug: "openai",
        voice: "alloy",
        format: "mp3",
        mediaType: "audio/mpeg",
        languages: "any",
        model: (apiKey) => createOpenAI({ apiKey }).speech("gpt-4o-mini-tts")
    },
    {
        slug: "elevenlabs",
        // The voice the AI SDK's ElevenLabs docs use ("Rachel").
        voice: "21m00Tcm4TlvDq8ikWAM",
        format: "mp3",
        mediaType: "audio/mpeg",
        languages: "any",
        model: (apiKey) => createElevenLabs({ apiKey }).speech("eleven_multilingual_v2")
    },
    {
        slug: "google-ai",
        voice: "Kore",
        format: "wav",
        mediaType: "audio/wav",
        languages: "any",
        model: (apiKey) => createGoogle({ apiKey }).speech("gemini-3.8-flash-tts")
    },
    {
        // Voxtral infers the language from the text (AI SDK Mistral docs).
        slug: "mistral",
        voice: "en_paul_neutral",
        format: "mp3",
        mediaType: "audio/mpeg",
        languages: "any",
        model: (apiKey) => createMistral({ apiKey }).speech("voxtral-mini-tts-2603")
    },
    {
        slug: "deepgram",
        voice: "thalia",
        format: "mp3",
        mediaType: "audio/mpeg",
        languages: ["en"],
        model: (apiKey) => createDeepgram({ apiKey }).speech("aura-2")
    },
    {
        slug: "groq",
        voice: "troy",
        format: "wav",
        mediaType: "audio/wav",
        languages: ["en"],
        model: (apiKey) =>
            createOpenAI({ apiKey, baseURL: GROQ_OPENAI_BASE }).speech(
                "canopylabs/orpheus-v1-english"
            )
    }
];

/** The primary subtag of a language tag ("es-ES" -> "es"), or null. */
function primaryLanguage(lang: string | null | undefined): string | null {
    const primary = (lang ?? "").split("-")[0]?.trim().toLowerCase() ?? "";
    return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

/** The speech providers a key is held for that can say something in `lang`,
 *  best first. Without a language, every one held. */
export function speechCandidates(
    held: { has: (slug: string) => boolean },
    lang?: string | null
): VoiceProvider[] {
    const primary = primaryLanguage(lang);
    return VOICE_PROVIDERS.filter(
        (provider) =>
            held.has(provider.slug) &&
            (provider.languages === "any" || !primary || provider.languages.includes(primary))
    );
}

type FoundVoice = { provider: VoiceProvider; credential: ChatCredential };

/** A call asks for every sentence: the provider and key found for one are
 *  reused for the next few seconds instead of read again from the key store. */
const FOUND_TTL_MS = 30_000;
const FOUND_MOST = 1000;
const found = new Map<string, { at: number; value: FoundVoice }>();

/** The first voice provider this person holds a key for, spending only the
 *  payer's key when they picked who pays. */
async function voiceProviderFor(
    userId: string,
    payer: Payer | null,
    lang: string | null
): Promise<FoundVoice | null> {
    const key = `${userId}:${payer ?? ""}:${primaryLanguage(lang) ?? ""}`;
    const now = Date.now();
    const cached = found.get(key);
    if (cached && now - cached.at < FOUND_TTL_MS) return cached.value;
    found.delete(key);
    const access = await polarAccessFor(userId);
    const sources = await polarKeySources(userId, access);
    for (const provider of speechCandidates(sources, lang)) {
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
            speech: speechCandidates(sources).length > 0,
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

/** The speech model for this person that can say something in `lang`, or
 *  null without one: the browser speaks instead. */
export async function polarSpeaker(
    userId: string,
    payer: Payer | null = null,
    lang: string | null = null
): Promise<PolarSpeaker | null> {
    const voice = await voiceProviderFor(userId, payer, lang);
    if (!voice) return null;
    const { provider } = voice;
    return {
        model: provider.model(voice.credential.secret),
        voice: provider.voice,
        format: provider.format,
        mediaType: provider.mediaType
    };
}
