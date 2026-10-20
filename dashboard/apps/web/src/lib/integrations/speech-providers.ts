/**
 * The providers whose keys only turn speech into text: no chat model of their
 * own, so they are not in the model table (`model-providers.ts`), which gives
 * every row a default model for repositories to run on.
 *
 * They are stored with the same key dialog and handed to a run under the
 * variable each one's AI SDK package reads, like every other key. Polar's
 * dictation is what spends them (`lib/polar/transcription.ts`).
 *
 * The variables are the ones the packages themselves load (`@ai-sdk/elevenlabs`
 * and the rest, `loadApiKey`); the documentation links are the ones the AI
 * SDK's provider pages point to (ai-sdk.dev/providers/ai-sdk-providers).
 */

import type { IntegrationCatalogEntry } from "@/lib/integrations/registry";

export interface SpeechProviderSeed {
    slug: string;
    name: string;
    envVar: string;
    summary: string;
    docsUrl: string;
    keyUrl: string;
}

// i18n-ignore (marked per line below): names are the providers' own; the card's words come from `integrationWords`.
export const SPEECH_PROVIDER_SEEDS: readonly SpeechProviderSeed[] = [
    {
        slug: "elevenlabs",
        name: "ElevenLabs", // i18n-ignore
        envVar: "ELEVENLABS_API_KEY",
        summary: "Scribe, its speech-to-text model.", // i18n-ignore
        docsUrl: "https://elevenlabs.io/speech-to-text",
        keyUrl: "https://elevenlabs.io/app/settings/api-keys"
    },
    {
        slug: "deepgram",
        name: "Deepgram", // i18n-ignore
        envVar: "DEEPGRAM_API_KEY",
        summary: "Nova, fast speech-to-text.", // i18n-ignore
        docsUrl: "https://developers.deepgram.com/docs/models-languages-overview",
        keyUrl: "https://console.deepgram.com/"
    },
    {
        slug: "assemblyai",
        name: "AssemblyAI", // i18n-ignore
        envVar: "ASSEMBLYAI_API_KEY",
        summary: "Universal, its speech-to-text models.", // i18n-ignore
        docsUrl: "https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model",
        keyUrl: "https://www.assemblyai.com/dashboard"
    },
    {
        slug: "gladia",
        name: "Gladia", // i18n-ignore
        envVar: "GLADIA_API_KEY",
        summary: "Speech-to-text in many languages.", // i18n-ignore
        docsUrl: "https://docs.gladia.io/chapters/pre-recorded-stt/getting-started",
        keyUrl: "https://app.gladia.io/"
    },
    {
        slug: "revai",
        name: "Rev.ai", // i18n-ignore
        envVar: "REVAI_API_KEY",
        summary: "Speech-to-text from Rev.", // i18n-ignore
        docsUrl: "https://www.rev.ai/docs/api/transcription",
        keyUrl: "https://www.rev.ai/access_token"
    },
    {
        slug: "fal",
        name: "fal", // i18n-ignore
        envVar: "FAL_API_KEY",
        summary: "Hosted Whisper models.", // i18n-ignore
        docsUrl: "https://docs.fal.ai/guides/convert-speech-to-text",
        keyUrl: "https://fal.ai/dashboard/keys"
    }
];

/** The speech providers as key-dialog entries, after the model providers. */
export const SEEDED_SPEECH_INTEGRATIONS: readonly IntegrationCatalogEntry[] = SPEECH_PROVIDER_SEEDS.map((seed) => ({
    slug: seed.slug,
    name: seed.name,
    category: "Models" as const,
    summary: seed.summary,
    description: `Connects your ${seed.name} account so Polar can turn what you say into text. The key is held here and never copied into your repositories. Usage is billed by ${seed.name} directly.`, // i18n-ignore
    docsUrl: seed.docsUrl,
    setupLinks: [{ label: "Create an API key", url: seed.keyUrl }], // i18n-ignore
    requiresApiKey: true,
    apiKeyLabel: "API key" // i18n-ignore
}));
