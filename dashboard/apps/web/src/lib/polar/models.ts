/**
 * Which models Polar can talk to for one person, and the AI SDK model for a
 * choice.
 *
 * The keys are the ones the rest of Polaris already holds (`model-keys.ts`):
 * the person's own first, then the deployment's when an administrator shares
 * them. The models are the catalogue's (`model-catalog.ts`), so nothing here
 * names a model id of its own; the gateway serves the one model its owner
 * configured.
 *
 * Built around a `kind` so image, video and speech models can join as one more
 * factory each without changing what a message carries.
 *
 * Server-only.
 */

import type { LanguageModel } from "ai";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { modelProviderName } from "@/lib/agents/model-key-providers";
import { isAutomatic, type Intelligence, type ModelChoice, type Payer } from "@/lib/polar/shared";
import {
    autoRoute,
    automaticCandidates,
    failingProviders,
    PLAIN_TURN,
    type AutoRoute,
    type TurnSignals
} from "@/lib/polar/automatic";
import { GATEWAY_SLUG, MODEL_PROVIDERS } from "@/lib/agents/agent-providers";
import { listCatalogModels, type CatalogModel } from "@/lib/agents/model-catalog";
import type { ChatCredential } from "@/lib/agents/model-keys";
import {
    polarAccessFor,
    polarCredentialFor,
    polarKeySources,
    type PolarAccess
} from "@/lib/polar/access";

/**
 * Base URLs of the providers that speak the OpenAI chat API, taken from the
 * endpoints Polaris already checks their keys against (`provider-key-check.ts`).
 */
const OPENAI_COMPATIBLE_BASES: Readonly<Record<string, string>> = {
    xai: "https://api.x.ai/v1",
    deepseek: "https://api.deepseek.com",
    moonshot: "https://api.moonshot.ai/v1",
    groq: "https://api.groq.com/openai/v1",
    cerebras: "https://api.cerebras.ai/v1",
    openrouter: "https://openrouter.ai/api/v1"
};

/** Whether Polar has a way to call this provider at all. */
export function polarServesProvider(slug: string): boolean {
    return (
        slug === "anthropic" ||
        slug === "openai" ||
        slug === "google-ai" ||
        slug === GATEWAY_SLUG ||
        slug in OPENAI_COMPATIBLE_BASES
    );
}

/** One model as the picker lists it. */
export interface PolarModelOption {
    provider: string;
    providerName: string;
    model: string;
    name: string;
    reasoning: boolean;
    attachment: boolean;
    contextTokens: number;
    /** Price per million input tokens, when the catalogue knows it. */
    costInput: number | null;
    /** Price per million output tokens, when the catalogue knows it. */
    costOutput: number | null;
    releaseDate: string | null;
}

/** One provider as the picker lists it, with who would pay. */
export interface PolarProviderOption {
    provider: string;
    name: string;
    payers: Payer[];
    models: PolarModelOption[];
}

/**
 * The providers and models this person can use now: only providers with a
 * usable key, only models the catalogue carries for them.
 */
export async function polarModelOptions(
    userId: string,
    access?: PolarAccess
): Promise<PolarProviderOption[]> {
    const granted = access ?? (await polarAccessFor(userId));
    const sources = await polarKeySources(userId, granted);
    const served = [...sources.keys()].filter(polarServesProvider);
    if (served.length === 0) return [];
    const prefixes = new Map<string, string>();
    for (const slug of served) {
        const prefix = MODEL_PROVIDERS.find((provider) => provider.slug === slug)?.modelPrefix;
        if (prefix) prefixes.set(prefix, slug);
    }
    const catalogue = prefixes.size > 0 ? await listCatalogModels([...prefixes.keys()]) : [];
    const options: PolarProviderOption[] = [];
    for (const slug of served) {
        const payers: Payer[] = [sources.get(slug) ?? "own"];
        const name = modelProviderName(slug);
        let models: PolarModelOption[];
        if (slug === GATEWAY_SLUG) {
            const credential = await polarCredentialFor(userId, slug, null, granted);
            models = credential?.gatewayModel
                ? [gatewayOption(slug, name, credential.gatewayModel)]
                : [];
        } else {
            models = catalogue
                .filter((model) => prefixes.get(model.provider) === slug)
                .map((model) => catalogueOption(slug, name, model));
        }
        if (models.length > 0) options.push({ provider: slug, name, payers, models });
    }
    return options;
}

function catalogueOption(
    slug: string,
    providerName: string,
    model: CatalogModel
): PolarModelOption {
    return {
        provider: slug,
        providerName,
        model: model.modelId,
        name: model.name,
        reasoning: model.reasoning,
        attachment: model.attachment,
        contextTokens: model.contextTokens,
        costInput: model.costInput,
        costOutput: model.costOutput,
        releaseDate: model.releaseDate
    };
}

function gatewayOption(slug: string, providerName: string, model: string): PolarModelOption {
    return {
        provider: slug,
        providerName,
        model,
        name: model,
        reasoning: false,
        attachment: false,
        contextTokens: 0,
        costInput: null,
        costOutput: null,
        releaseDate: null
    };
}

/** The AI SDK's provider-neutral reasoning level for each intelligence step. */
const REASONING: Readonly<Record<Intelligence, "low" | "medium" | "high" | "xhigh">> = {
    fast: "low",
    balanced: "medium",
    deep: "high",
    max: "xhigh"
};

/** The `reasoning` call option, or undefined for a model that does not reason:
 *  sending one to such a model is an error on some providers. */
export function reasoningFor(
    intelligence: Intelligence,
    option: Pick<PolarModelOption, "reasoning">
): (typeof REASONING)[Intelligence] | undefined {
    return option.reasoning ? REASONING[intelligence] : undefined;
}

/** Why a choice cannot be served, as a code the screen has words for. */
export type ModelRefusal = "no_key" | "unknown_model" | "unsupported_kind";

export interface ResolvedModel {
    model: LanguageModel;
    option: PolarModelOption;
    credential: ChatCredential;
    /** Set when Automatic picked the model: the kind of turn it saw. */
    automatic?: AutoRoute;
}

/**
 * The model for a choice, checked against what this person may use: the
 * provider must have a key they can spend and the model must be one the
 * picker would have offered.
 */
export async function resolvePolarModel(
    userId: string,
    choice: ModelChoice,
    signals: TurnSignals = PLAIN_TURN,
    access?: PolarAccess
): Promise<ResolvedModel | ModelRefusal> {
    if (choice.kind !== "language") return "unsupported_kind";
    const granted = access ?? (await polarAccessFor(userId));
    if (isAutomatic(choice)) return resolveAutomatic(userId, signals, granted);
    const provider = (await polarModelOptions(userId, granted)).find(
        (entry) => entry.provider === choice.provider
    );
    if (!provider) return "no_key";
    if (choice.payer && !provider.payers.includes(choice.payer)) return "no_key";
    const option = provider.models.find((model) => model.model === choice.model);
    if (!option) return "unknown_model";
    const credential = await polarCredentialFor(userId, choice.provider, choice.payer, granted);
    if (!credential) return "no_key";
    return { model: languageModel(credential, option.model), option, credential };
}

/** The AI SDK model for a credential. */
export function languageModel(credential: ChatCredential, model: string): LanguageModel {
    const apiKey = credential.secret;
    switch (credential.provider) {
        case "anthropic":
            return createAnthropic({ apiKey })(model);
        case "openai":
            return createOpenAI({ apiKey })(model);
        case "google-ai":
            return createGoogle({ apiKey })(model);
        case GATEWAY_SLUG:
            return createOpenAICompatible({
                name: "gateway",
                baseURL: credential.baseUrl ?? "",
                apiKey: apiKey || undefined
            })(model);
        default: {
            const baseURL = OPENAI_COMPATIBLE_BASES[credential.provider];
            if (!baseURL) throw new Error(`polar: no client for ${credential.provider}`);
            return createOpenAICompatible({ name: credential.provider, baseURL, apiKey })(model);
        }
    }
}

/**
 * The model Automatic answers a turn with: the first candidate whose key can
 * be read. "no_key" when none can.
 */
async function resolveAutomatic(
    userId: string,
    signals: TurnSignals,
    access: PolarAccess
): Promise<ResolvedModel | ModelRefusal> {
    const candidates = automaticCandidates(
        await polarModelOptions(userId, access),
        signals,
        failingProviders(userId)
    );
    const route = autoRoute(signals);
    const tried = new Map<string, ChatCredential | null>();
    for (const option of candidates) {
        if (!tried.has(option.provider)) {
            tried.set(
                option.provider,
                await polarCredentialFor(userId, option.provider, null, access)
            );
        }
        const credential = tried.get(option.provider);
        if (!credential) continue;
        return {
            model: languageModel(credential, option.model),
            option,
            credential,
            automatic: route
        };
    }
    return "no_key";
}
