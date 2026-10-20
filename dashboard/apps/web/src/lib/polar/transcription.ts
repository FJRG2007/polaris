/**
 * The models Polar can hear you with: every speech-to-text model the AI SDK
 * carries a provider for, keyed by the provider slug a key is stored under.
 *
 * The model ids are the ones each provider package's types list (AI SDK
 * `experimental_transcribe`, ai-sdk.dev/docs/ai-sdk-core/transcription):
 * `@ai-sdk/groq`, `@ai-sdk/openai`, `@ai-sdk/deepgram`, `@ai-sdk/elevenlabs`,
 * `@ai-sdk/mistral`, `@ai-sdk/google`, `@ai-sdk/assemblyai`, `@ai-sdk/gladia`,
 * `@ai-sdk/revai` and `@ai-sdk/fal`. Fastest first: with nothing picked, the
 * first model of the first provider somebody holds a key for is the one used.
 *
 * Client-safe: the picker reads the same list the server resolves against.
 */

import { z } from "zod";

export interface TranscriptionModelEntry {
    /** The provider's own model id, as its package names it. */
    id: string;
    /** Said as the provider says it. */
    label: string;
}

export interface TranscriptionProviderEntry {
    /** The slug a key is stored under (`model-keys.ts`). */
    slug: string;
    name: string;
    models: readonly TranscriptionModelEntry[];
}

// Provider and model names are the providers' own, so each is marked i18n-ignore.
export const TRANSCRIPTION_PROVIDERS: readonly TranscriptionProviderEntry[] = [
    {
        slug: "groq",
        name: "Groq", // i18n-ignore
        models: [
            { id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo" }, // i18n-ignore
            { id: "whisper-large-v3", label: "Whisper Large v3" } // i18n-ignore
        ]
    },
    {
        slug: "deepgram",
        name: "Deepgram", // i18n-ignore
        models: [
            { id: "nova-3", label: "Nova 3" }, // i18n-ignore
            { id: "nova-2", label: "Nova 2" } // i18n-ignore
        ]
    },
    {
        slug: "openai",
        name: "OpenAI", // i18n-ignore
        models: [
            { id: "gpt-4o-mini-transcribe", label: "GPT-4o mini Transcribe" }, // i18n-ignore
            { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe" }, // i18n-ignore
            { id: "whisper-1", label: "Whisper" } // i18n-ignore
        ]
    },
    {
        slug: "elevenlabs",
        name: "ElevenLabs", // i18n-ignore
        models: [
            { id: "scribe_v2", label: "Scribe v2" }, // i18n-ignore
            { id: "scribe_v1", label: "Scribe v1" } // i18n-ignore
        ]
    },
    {
        slug: "mistral",
        name: "Mistral", // i18n-ignore
        models: [{ id: "voxtral-mini-latest", label: "Voxtral Mini" }] // i18n-ignore
    },
    {
        slug: "google-ai",
        name: "Google AI", // i18n-ignore
        models: [{ id: "gemini-3.5-transcribe", label: "Gemini 3.5 Transcribe" }] // i18n-ignore
    },
    {
        slug: "assemblyai",
        name: "AssemblyAI", // i18n-ignore
        models: [
            { id: "universal-3-5-pro", label: "Universal 3.5 Pro" }, // i18n-ignore
            { id: "universal-2", label: "Universal 2" } // i18n-ignore
        ]
    },
    {
        slug: "gladia",
        name: "Gladia", // i18n-ignore
        // The package serves one model and takes no id for it.
        models: [{ id: "default", label: "Gladia" }] // i18n-ignore
    },
    {
        slug: "revai",
        name: "Rev.ai", // i18n-ignore
        models: [
            { id: "machine", label: "Machine" }, // i18n-ignore
            { id: "fusion", label: "Fusion" }, // i18n-ignore
            { id: "low_cost", label: "Low cost" } // i18n-ignore
        ]
    },
    {
        slug: "fal",
        name: "fal", // i18n-ignore
        models: [
            { id: "wizper", label: "Wizper" }, // i18n-ignore
            { id: "whisper", label: "Whisper" } // i18n-ignore
        ]
    }
];

/** One model somebody can pick, as the menu shows it. */
export interface TranscriptionOption {
    /** `provider/model`, the value that is stored and sent. */
    id: string;
    provider: string;
    providerName: string;
    model: string;
    label: string;
}

/** A stored or sent pick: `provider/model`, nothing longer than any real one. */
export const transcriptionChoiceSchema = z
    .string()
    .trim()
    .max(80)
    .regex(/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/);

export function transcriptionId(provider: string, model: string): string {
    return `${provider}/${model}`;
}

/** Every model a key is held for, grouped by provider in the catalogue's order. */
export function transcriptionOptions(providers: {
    has(slug: string): boolean;
}): TranscriptionOption[] {
    return TRANSCRIPTION_PROVIDERS.filter((provider) => providers.has(provider.slug)).flatMap(
        (provider) =>
            provider.models.map((model) => ({
                id: transcriptionId(provider.slug, model.id),
                provider: provider.slug,
                providerName: provider.name,
                model: model.id,
                label: model.label
            }))
    );
}

/**
 * The model to hear with: the one picked while its key is still there, and the
 * fastest one available otherwise - a removed key falls back rather than
 * leaving dictation broken.
 */
export function pickTranscription(
    options: readonly TranscriptionOption[],
    chosen: string | null | undefined
): TranscriptionOption | null {
    return options.find((option) => option.id === chosen) ?? options[0] ?? null;
}
