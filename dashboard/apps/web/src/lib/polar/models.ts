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
import { createMistral } from "@ai-sdk/mistral";
import { PROVIDER_ENDPOINTS } from "@/lib/polar/provider-endpoints";
import { polarRouting } from "@/lib/polar/router/store";
import {
    planSteps,
    plannedStep,
    routedModel,
    type PlanEntry,
    type PlannedStep,
    type RoutedModel
} from "@/lib/polar/router/plan";
import type { RouteTarget } from "@/lib/polar/routing";
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
import { creditMiddleware, freeVariantOf, isFreeModel } from "@/lib/polar/credit";
import {
    polarAccessFor,
    polarCredentialFor,
    polarCredentialsFor,
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
        slug in OPENAI_COMPATIBLE_BASES ||
        slug in PROVIDER_ENDPOINTS
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
    /** The router's plan and what it learned while walking it. */
    routed?: RoutedModel;
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
 * `resolved`, routed on to `sources` in order when its call is refused
 * (`router/chain.ts`). Adding stand-ins to a model that already has a plan
 * extends the same plan, so a turn walks one list.
 */
export function withStandIn(resolved: ResolvedModel, ...sources: StandInSource[]): ResolvedModel {
    if (sources.length === 0 && resolved.routed) return resolved;
    const fixed = (source: StandInSource): PlannedStep =>
        plannedStep(
            { option: source.option, credentials: [source.credential], build: () => source.model },
            source.credential
        );
    const head = resolved.routed?.steps ?? [fixed({ ...resolved, model: resolved.base ?? resolved.model })];
    const origin = head[0]!.provider;
    return {
        ...resolvedOf([...head, ...sources.map(fixed)], (kind, provider) => {
            if (provider === origin) resolved.onRefused?.(kind);
        }),
        automatic: resolved.automatic,
        onRefused: resolved.onRefused,
        base: resolved.base ?? resolved.model
    };
}

/** The resolved model for a plan: its first step is the one chosen, the rest
 *  stand in, in order. */
function resolvedOf(
    steps: readonly PlannedStep[],
    onRefused?: (kind: FailureKind, provider: string) => void
): ResolvedModel {
    const routed = routedModel(steps, (kind, step) => onRefused?.(kind, step.provider));
    const head = steps[0]!;
    return {
        model: routed.model,
        option: head.option,
        credential: head.credential,
        routed,
        standIns: steps.slice(1).map((step) => ({
            option: step.option,
            credential: step.credential,
            used: () => routed.answered() === step
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
    access?: PolarAccess,
    options: ResolveOptions = {}
): Promise<ResolvedModel | ModelRefusal> {
    if (choice.kind !== "language") return "unsupported_kind";
    const granted = access ?? (await polarAccessFor(userId));
    if (isAutomatic(choice)) return resolveAutomatic(userId, signals, granted, options);
    const catalogue = await polarModelOptions(userId, granted);
    const provider = catalogue.find((entry) => entry.provider === choice.provider);
    if (!provider) return "no_key";
    if (choice.payer && !provider.payers.includes(choice.payer)) return "no_key";
    const option = provider.models.find((model) => model.model === choice.model);
    if (!option) return "unknown_model";
    const held = await polarCredentialsFor(userId, choice.provider, choice.payer, granted);
    const credentials = options.keyId ? held.filter((key) => key.keyId === options.keyId) : held;
    if (credentials.length === 0) return "no_key";
    const routing = await polarRouting(userId);
    const keysOf = credentialCache(userId, granted);
    const entries: PlanEntry[] = [
        entryOf(userId, option, credentials, catalogue, options.reasoning)
    ];
    if (routing.pinnedFallsBack || options.fallBack) {
        entries.push(...(await fallbackEntries(userId, routing.fallbacks, catalogue, keysOf)));
    }
    const steps = await planSteps(entries, async () => !(await polarLimitReached(userId)));
    return resolvedOf(steps, (kind, slug) => rememberRefusal(userId, slug, kind));
}

/** What a caller outside the composer may ask of a resolution. */
export interface ResolveOptions {
    /** One stored key the first model must spend, as a tier pinned it. */
    keyId?: string | null;
    /** The effort the first model runs at (`routing.ts`); its fallbacks keep
     *  their own. */
    reasoning?: RouteTarget["reasoning"];
    /** Walk the fallback list even for a model named by hand: a coding tool's
     *  tier is configured routing, not a pick the person made in the moment. */
    fallBack?: boolean;
}

/** The keys of each provider for one call, read once per provider. */
function credentialCache(userId: string, access: PolarAccess) {
    const read = new Map<string, Promise<ChatCredential[]>>();
    return (provider: string): Promise<ChatCredential[]> => {
        if (!read.has(provider)) {
            read.set(provider, polarCredentialsFor(userId, provider, null, access));
        }
        return read.get(provider)!;
    };
}

/** A model to plan, on these keys. */
function entryOf(
    userId: string,
    option: PolarModelOption,
    credentials: readonly ChatCredential[],
    options: readonly PolarProviderOption[],
    reasoning?: RouteTarget["reasoning"]
): PlanEntry {
    const models = options.find((entry) => entry.provider === option.provider)?.models ?? [];
    return {
        option,
        credentials,
        reasoning,
        build: (credential) =>
            languageModel(
                credential,
                option.model,
                freeVariantOf(option.provider, option.model, models),
                () => noteNoCredit(userId, option.provider)
            )
    };
}

/**
 * The person's fallback list as plan entries: each model they may still use,
 * on the one key it names or on every key held for its provider. An entry
 * whose provider, model or key is gone is skipped rather than failing the turn.
 */
async function fallbackEntries(
    userId: string,
    targets: readonly RouteTarget[],
    options: readonly PolarProviderOption[],
    keysOf: (provider: string) => Promise<ChatCredential[]>
): Promise<PlanEntry[]> {
    const entries: PlanEntry[] = [];
    for (const target of targets) {
        const option = options
            .find((entry) => entry.provider === target.provider)
            ?.models.find((model) => model.model === target.model);
        if (!option) continue;
        const keys = await keysOf(target.provider);
        const credentials = target.keyId ? keys.filter((key) => key.keyId === target.keyId) : keys;
        if (credentials.length === 0) continue;
        entries.push(entryOf(userId, option, credentials, options, target.reasoning));
    }
    return entries;
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
            const endpoint = PROVIDER_ENDPOINTS[credential.provider];
            if (endpoint?.api === "anthropic") {
                return createAnthropic({ apiKey, baseURL: endpoint.baseUrl })(model);
            }
            if (endpoint?.api === "mistral") {
                return createMistral({ apiKey, baseURL: endpoint.baseUrl })(model);
            }
            const baseURL = OPENAI_COMPATIBLE_BASES[credential.provider] ?? endpoint?.baseUrl;
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
 * The model Automatic answers a turn with: the first candidate a key is held
 * for, on each of its provider's keys, then - in this order - its own
 * provider's next free candidate (and, for a paid first pick, the next paid
 * one), the person's fallback list, and the first candidate of up to three
 * other providers they may spend on. Another provider's key from this Polaris
 * is offered only while the administrator's ceilings leave room, as the turn
 * itself would be. A provider that refused for want of credit lately is
 * offered only its free models. "no_key" when no candidate has a key.
 */
async function resolveAutomatic(
    userId: string,
    signals: TurnSignals,
    access: PolarAccess,
    resolve: ResolveOptions = {}
): Promise<ResolvedModel | ModelRefusal> {
    const options = await polarModelOptions(userId, access);
    const candidates = automaticCandidates(
        options,
        signals,
        failingProviders(userId),
        unpaidProviders(userId)
    );
    const route = autoRoute(signals);
    const keysOf = credentialCache(userId, access);
    for (const [index, option] of candidates.entries()) {
        const credentials = await keysOf(option.provider);
        if (credentials.length === 0) continue;
        const later = candidates.slice(index + 1);
        // Same provider first: the turn's provider tools and options are that
        // provider's, and the purse its ceiling was checked against.
        const mine = later.filter((entry) => entry.provider === option.provider);
        const free = mine.find(isFreeModel);
        const paid = isFreeModel(option) ? undefined : mine.find((entry) => !isFreeModel(entry));
        const routing = await polarRouting(userId);
        const entries: PlanEntry[] = [
            entryOf(userId, option, credentials, options, resolve.reasoning),
            ...[free, paid]
                .filter((entry): entry is PolarModelOption => !!entry)
                .map((entry) => entryOf(userId, entry, credentials, options)),
            ...(await fallbackEntries(userId, routing.fallbacks, options, keysOf))
        ];
        const seen = new Set([option.provider]);
        let others = 0;
        for (const entry of later) {
            if (others >= OTHER_PROVIDERS_MOST) break;
            if (seen.has(entry.provider)) continue;
            seen.add(entry.provider);
            const keys = await keysOf(entry.provider);
            if (keys.length === 0) continue;
            entries.push(entryOf(userId, entry, keys, options));
            others++;
        }
        const steps = await planSteps(entries, async () => !(await polarLimitReached(userId)));
        return {
            ...resolvedOf(steps, (kind, slug) => rememberRefusal(userId, slug, kind)),
            automatic: route,
            onRefused: (kind) => rememberRefusal(userId, option.provider, kind)
        };
    }
    return "no_key";
}
