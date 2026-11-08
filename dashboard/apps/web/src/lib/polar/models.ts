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

import { wrapLanguageModel, type LanguageModel } from "ai";
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
    noteNoCredit,
    noteProviderFailure,
    PLAIN_TURN,
    unpaidProviders,
    type AutoRoute,
    type TurnSignals
} from "@/lib/polar/automatic";
import {
    GATEWAY_SLUG,
    MODEL_PROVIDERS,
    anthropicWorkspaceHeaders
} from "@/lib/agents/agent-providers";
import { listCatalogModels, type CatalogModel } from "@/lib/agents/model-catalog";
import type { ChatCredential } from "@/lib/agents/model-keys";
import { providerWindows, WINDOW_PROVIDERS } from "@/lib/polar/provider-windows";
import {
    creditMiddleware,
    freeVariantOf,
    isFreeModel,
    polarOutputTokens,
    standInMiddleware,
    type LanguageModelV4
} from "@/lib/polar/credit";
import {
    polarAccessFor,
    polarCredentialFor,
    polarKeySources,
    type PolarAccess
} from "@/lib/polar/access";
import { polarLimitReached } from "@/lib/polar/usage";
import type { FailureKind } from "@/lib/polar/provider-failure";

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
    /** The longest answer the catalogue says the model writes; 0 or absent
     *  when unknown. */
    outputTokens?: number;
    /** The window the provider's own API reports, when it reports one; it
     *  wins over the catalogue's `contextTokens` (`provider-windows.ts`). */
    providerContextTokens: number | null;
    /** Price per million input tokens, when the catalogue knows it. */
    costInput: number | null;
    /** Price per million output tokens, when the catalogue knows it. */
    costOutput: number | null;
    /** What it reads, from the catalogue ("image", "pdf", ...); empty when unknown. */
    inputs: string[];
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
 * usable key, only models the catalogue carries for them. `waitForWindows`
 * reads a provider's windows now when none are remembered yet (the picker);
 * otherwise the remembered ones are used and refreshed in the background.
 */
export async function polarModelOptions(
    userId: string,
    access?: PolarAccess,
    { waitForWindows = false }: { waitForWindows?: boolean } = {}
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
    const [catalogue, windows] = await Promise.all([
        prefixes.size > 0 ? listCatalogModels([...prefixes.keys()]) : [],
        windowsBySlug(userId, served, granted, waitForWindows)
    ]);
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
                .map((model) =>
                    catalogueOption(
                        slug,
                        name,
                        model,
                        windows.get(slug)?.get(model.modelId) ?? null
                    )
                );
        }
        if (models.length > 0) options.push({ provider: slug, name, payers, models });
    }
    return options;
}

/** The windows each served provider's API reports, for the providers that
 *  report any. A provider that cannot be asked reports none. */
async function windowsBySlug(
    userId: string,
    served: readonly string[],
    access: PolarAccess,
    wait: boolean
): Promise<Map<string, ReadonlyMap<string, number>>> {
    const asked = served.filter((slug) => (WINDOW_PROVIDERS as readonly string[]).includes(slug));
    return new Map(
        await Promise.all(
            asked.map(async (slug) => {
                const credential = await polarCredentialFor(userId, slug, null, access).catch(
                    () => null
                );
                return [slug, await providerWindows(credential, { wait })] as const;
            })
        )
    );
}

function catalogueOption(
    slug: string,
    providerName: string,
    model: CatalogModel,
    providerContextTokens: number | null
): PolarModelOption {
    return {
        provider: slug,
        providerName,
        model: model.modelId,
        name: model.name,
        reasoning: model.reasoning,
        attachment: model.attachment,
        contextTokens: model.contextTokens,
        outputTokens: model.outputTokens,
        providerContextTokens,
        costInput: model.costInput,
        costOutput: model.costOutput,
        inputs: model.inputModalities ?? [],
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
        providerContextTokens: null,
        costInput: null,
        costOutput: null,
        inputs: [],
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
    /** The models asked instead when this one is refused (`withStandIn`), in
     *  the order they are tried. */
    standIns?: readonly StandIn[];
    /** The model before any stand-in was wrapped around it, so adding one
     *  more keeps a single retry. */
    base?: LanguageModel;
    /** What the stand-ins were built from, for the same reason. */
    standInSources?: readonly StandInSource[];
    /** Runs with the kind of refusal the chosen model met, when a stand-in
     *  middleware saw it: Automatic remembers the provider for later turns. */
    onRefused?: (kind: FailureKind) => void;
}

/** A model that may answer in place of the one chosen, and whether it did. */
export interface StandIn {
    option: PolarModelOption;
    credential: ChatCredential;
    used: () => boolean;
}

/** A model to add as a stand-in. */
export type StandInSource = Pick<ResolvedModel, "model" | "option" | "credential">;

/**
 * `resolved`, asking the first fitting of `sources` once when its call is
 * refused (`standInMiddleware` in `credit.ts`). Only for a model Polar chose:
 * one the person pinned keeps its own refusal. Adding stand-ins to a model
 * that already has some extends the same list, so a turn is still retried
 * once at most.
 */
export function withStandIn(resolved: ResolvedModel, ...sources: StandInSource[]): ResolvedModel {
    const all = [...(resolved.standInSources ?? []), ...sources];
    if (all.length === 0) return resolved;
    const base = resolved.base ?? resolved.model;
    let usedAt = -1;
    const model = wrapLanguageModel({
        model: base as LanguageModelV4,
        middleware: standInMiddleware(
            resolved.option.provider,
            all.map((source) => ({
                model: () => source.model as LanguageModelV4,
                provider: source.option.provider,
                free: isFreeModel(source.option),
                reasoning: source.option.reasoning,
                outputTokens: polarOutputTokens(source.option)
            })),
            {
                onStandIn: (index) => {
                    usedAt = index;
                },
                onRefused: resolved.onRefused
            }
        )
    });
    return {
        ...resolved,
        model,
        base,
        standInSources: all,
        standIns: all.map((source, index) => ({
            option: source.option,
            credential: source.credential,
            used: () => usedAt === index
        }))
    };
}

/** The model that actually answered: the stand-in that was asked, else the
 *  one chosen. */
export function answeredBy(
    resolved: Pick<ResolvedModel, "option" | "credential" | "standIns">
): Pick<ResolvedModel, "option" | "credential"> {
    return (resolved.standIns ?? []).find((entry) => entry.used()) ?? resolved;
}

/** What a refusal of `provider` teaches Automatic for this person's next
 *  turns: no credit offers only its free models for a while; a refused key,
 *  a rate limit or an outage puts the provider last for a few minutes. A
 *  model busy or gone is the model's, not the provider's. */
export function rememberRefusal(userId: string, provider: string, kind: FailureKind): void {
    if (kind === "credit" || kind === "paid") noteNoCredit(userId, provider);
    else if (kind === "key" || kind === "rate" || kind === "down") {
        noteProviderFailure(userId, provider);
    }
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
    return {
        model: languageModel(
            credential,
            option.model,
            freeVariantOf(option.provider, option.model, provider.models),
            () => noteNoCredit(userId, option.provider)
        ),
        option,
        credential
    };
}

/**
 * The AI SDK model for a credential. `free` is the model's no-cost variant on
 * OpenRouter, when the catalogue lists one: an account with no credit is
 * answered by it rather than refused (`credit.ts`).
 */
export function languageModel(
    credential: ChatCredential,
    model: string,
    free: string | null = null,
    onNoCredit?: () => void
): LanguageModel {
    const apiKey = credential.secret;
    switch (credential.provider) {
        case "anthropic":
            // A key not tied to one workspace names its workspace on every call.
            return createAnthropic({
                apiKey,
                headers: anthropicWorkspaceHeaders(credential.workspaceId)
            })(model);
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
            const client = createOpenAICompatible({ name: credential.provider, baseURL, apiKey });
            if (credential.provider !== "openrouter") return client(model);
            return wrapLanguageModel({
                model: client(model),
                middleware: creditMiddleware(free ? () => client(free) : null, onNoCredit)
            });
        }
    }
}

/** Most other providers a turn keeps a stand-in from: each costs a key read. */
const OTHER_PROVIDERS_MOST = 3;

/**
 * The model Automatic answers a turn with: the first candidate whose key can
 * be read, with stand-ins in Automatic's own order - its own provider's next
 * free candidate (and, for a paid first pick, the next paid one), then the
 * first candidate of each other provider this person may spend on. Another
 * provider's key from this Polaris is offered only while the administrator's
 * ceilings leave room, as the turn itself would be. A provider that refused
 * for want of credit lately is offered only its free models. "no_key" when no
 * candidate's key can be read.
 */
async function resolveAutomatic(
    userId: string,
    signals: TurnSignals,
    access: PolarAccess
): Promise<ResolvedModel | ModelRefusal> {
    const options = await polarModelOptions(userId, access);
    const candidates = automaticCandidates(
        options,
        signals,
        failingProviders(userId),
        unpaidProviders(userId)
    );
    const route = autoRoute(signals);
    const tried = new Map<string, ChatCredential | null>();
    const credentialOf = async (provider: string) => {
        if (!tried.has(provider)) {
            tried.set(provider, await polarCredentialFor(userId, provider, null, access));
        }
        return tried.get(provider) ?? null;
    };
    const build = (option: PolarModelOption, credential: ChatCredential) => ({
        model: languageModel(
            credential,
            option.model,
            freeVariantOf(
                option.provider,
                option.model,
                options.find((entry) => entry.provider === option.provider)?.models ?? []
            ),
            () => noteNoCredit(userId, option.provider)
        ),
        option,
        credential
    });
    for (const [index, option] of candidates.entries()) {
        const credential = await credentialOf(option.provider);
        if (!credential) continue;
        const chosen: ResolvedModel = {
            ...build(option, credential),
            automatic: route,
            onRefused: (kind) => rememberRefusal(userId, option.provider, kind)
        };
        const later = candidates.slice(index + 1);
        // Same provider and key first: the turn's provider tools and options
        // are that provider's, and the purse its ceiling was checked against.
        const mine = later.filter((entry) => entry.provider === option.provider);
        const free = mine.find(isFreeModel);
        const paid = isFreeModel(option) ? undefined : mine.find((entry) => !isFreeModel(entry));
        const sources: StandInSource[] = [free, paid]
            .filter((entry): entry is PolarModelOption => !!entry)
            .map((entry) => build(entry, credential));
        sources.push(
            ...(await otherStandIns(
                userId,
                later,
                option.provider,
                credential,
                credentialOf,
                build
            ))
        );
        return withStandIn(chosen, ...sources);
    }
    return "no_key";
}

/** The first candidate of each other provider whose key this person may spend
 *  now, in Automatic's order. */
async function otherStandIns(
    userId: string,
    later: readonly PolarModelOption[],
    provider: string,
    chosen: ChatCredential,
    credentialOf: (provider: string) => Promise<ChatCredential | null>,
    build: (option: PolarModelOption, credential: ChatCredential) => StandInSource
): Promise<StandInSource[]> {
    const found: StandInSource[] = [];
    const seen = new Set([provider]);
    let roomOnShared: boolean | null = chosen.source === "instance" ? true : null;
    for (const option of later) {
        if (found.length >= OTHER_PROVIDERS_MOST) break;
        if (seen.has(option.provider)) continue;
        seen.add(option.provider);
        const credential = await credentialOf(option.provider);
        if (!credential) continue;
        if (credential.source === "instance") {
            roomOnShared ??= !(await polarLimitReached(userId));
            if (!roomOnShared) continue;
        }
        found.push(build(option, credential));
    }
    return found;
}
