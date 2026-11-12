/**
 * Code's model-first choice: the person picks a model from one of their
 * sources - a linked subscription, an API key, the deployment's keys, a
 * machine's own sign-in - and Polaris works out which engine runs it. The
 * coding tool is never something they pick or see.
 *
 * Everything here is pure and client-safe, so the composer, the server that
 * re-resolves every start, and the tests read the same rules.
 *
 * The rules live in one table, `SOURCE_RULES`, keyed by the credential a
 * source signs in with (the catalogue's `credentials[].env`). Each lists the
 * engines that can use it, the vendor's own tool first. The resolver keeps to
 * the engines the catalogue actually offers for that account, so a rule can
 * order engines but never add one the catalogue does not declare.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import type { AgentModel, ModelPolicy } from "@/lib/polar/agents/shared";
import { polarSourceKey } from "@/lib/polar/picker-order";

/** Polar's own runtime: the chat model answers, no session is started. */
export const POLAR_RUNTIME = "polar";
/** The multi-provider tool that runs Polar's keys when a session is needed. */
export const POLAR_KEYS_ENGINE = "opencode";

export type CodeSourceKind = "subscription" | "apiKey" | "machine" | "server" | "polar";

/** One rule: what a credential is, whose it is, and what can run it. */
export interface SourceRule {
    /** The i18n key under `polar.code.sources`. */
    readonly id: string;
    readonly kind: "subscription" | "apiKey";
    readonly vendor: string;
    /** `IntegrationLogo` slug, or null to draw the engine's own mark. */
    readonly logo: string | null;
    /** Preferred first: the vendor's own tool, then the rest. */
    readonly engines: readonly string[];
}

/**
 * Credential -> engines. The one place a source is tied to a tool.
 *
 * - A subscription or plan runs on its vendor's own tool, the only one that
 *   can sign in with it.
 * - An Anthropic or OpenAI API key runs on that vendor's tool, which accepts
 *   the key; OpenCode reads the same key and is the fallback.
 * - Anything else (OpenRouter, Groq, ... on Account > AI keys) is a Polar
 *   source: Polar's own runtime, or OpenCode when a session is needed
 *   (`resolveCodeEngine`).
 */
export const SOURCE_RULES: Readonly<Record<string, SourceRule>> = {
    CLAUDE_CODE_OAUTH_TOKEN: { id: "claudePlan", kind: "subscription", vendor: "Anthropic", logo: "anthropic", engines: ["claude"] },
    ANTHROPIC_API_KEY: { id: "anthropicKey", kind: "apiKey", vendor: "Anthropic", logo: "anthropic", engines: ["claude", POLAR_KEYS_ENGINE] },
    CODEX_CHATGPT_AUTH: { id: "chatgptPlan", kind: "subscription", vendor: "OpenAI", logo: "openai", engines: ["codex"] },
    OPENAI_API_KEY: { id: "openaiKey", kind: "apiKey", vendor: "OpenAI", logo: "openai", engines: ["codex", POLAR_KEYS_ENGINE] },
    COPILOT_DEVICE_AUTH: { id: "copilotPlan", kind: "subscription", vendor: "GitHub", logo: "github", engines: ["copilot"] },
    GH_TOKEN: { id: "githubToken", kind: "apiKey", vendor: "GitHub", logo: "github", engines: ["copilot"] },
    GEMINI_GOOGLE_AUTH: { id: "googleAccount", kind: "subscription", vendor: "Google", logo: "google-ai", engines: ["gemini"] },
    GEMINI_API_KEY: { id: "geminiKey", kind: "apiKey", vendor: "Google", logo: "google-ai", engines: ["gemini"] },
    CURSOR_API_KEY: { id: "cursorKey", kind: "apiKey", vendor: "Cursor", logo: null, engines: ["cursor"] },
    AMP_API_KEY: { id: "ampKey", kind: "apiKey", vendor: "Amp", logo: null, engines: ["amp"] },
    FACTORY_API_KEY: { id: "factoryKey", kind: "apiKey", vendor: "Factory", logo: null, engines: ["droid"] }
};

/** The vendors whose own tool can run on a machine's sign-in, one each. */
const MACHINE_ENGINES: readonly string[] = ["claude", "codex", "gemini", "copilot", "cursor"];

/** The rule a vendor's own tool answers for, for a source with no credential
 *  of its own (a machine's sign-in, the deployment's environment). */
function ruleOfEngine(engine: string): SourceRule | null {
    return Object.values(SOURCE_RULES).find((rule) => rule.engines[0] === engine) ?? null;
}

/** What `agentOptionsFor` offers, as much of it as a source needs. */
export interface SourceOption {
    readonly key: string;
    readonly cli: string;
    readonly readiness: core.AgentReadiness;
    readonly accountId: string | null;
    readonly account: string | null;
    readonly mine: boolean | null;
    readonly machine: boolean;
    readonly apiKey: boolean;
    /** The credential the account signs in with; null for the machine and plain rows. */
    readonly env?: string | null;
}

/** A model a source can serve. `model` null is the account's own default. */
export interface CodeSourceModel {
    readonly provider: string;
    readonly model: string | null;
    readonly name: string;
}

export interface CodeSource {
    /** "account:<id>", "machine:<engine>", "server:<engine>" or "polar:<provider>". */
    readonly key: string;
    readonly kind: CodeSourceKind;
    /** The rule's i18n id, or the provider's name for a Polar source. */
    readonly label: string;
    readonly vendor: string;
    readonly logo: string | null;
    /** The account's name or address; null where there is none. */
    readonly account: string | null;
    readonly mine: boolean | null;
    readonly readiness: core.AgentReadiness;
    /** The engines that can run it, preferred first. Never shown. */
    readonly engines: readonly string[];
    readonly accountId: string | null;
    readonly machine: boolean;
    /** The chat provider an API key also is, so it is listed once. */
    readonly polarProvider: string | null;
    /** For a Polar source: whose key pays. */
    readonly payer: "own" | "instance" | null;
    readonly models: readonly CodeSourceModel[];
}

/** A model list a source keeps to, from the engine's saved settings. */
export interface EnginePolicy {
    readonly models: readonly AgentModel[];
    readonly modelPolicy: ModelPolicy;
}

export const accountSourceKey = (id: string) => `account:${id}`;
export const machineSourceKey = (engine: string) => `machine:${engine}`;
export const serverSourceKey = (engine: string) => `server:${engine}`;
export { polarSourceKey };
export const isPolarSource = (key: string) => key.startsWith("polar:");

/** The chat provider slug an API key credential is (`MODEL_PROVIDERS`). */
const POLAR_PROVIDER_OF: Readonly<Record<string, string>> = {
    ANTHROPIC_API_KEY: "anthropic",
    OPENAI_API_KEY: "openai",
    GEMINI_API_KEY: "google-ai"
};

/** Candidates in the rule's order, then the rest in the catalogue's. */
function ordered(candidates: readonly string[], rule: SourceRule | null): string[] {
    const preferred = (rule?.engines ?? []).filter((engine) => candidates.includes(engine));
    return [...preferred, ...candidates.filter((engine) => !preferred.includes(engine))];
}

/** The models an engine serves, kept to its saved list when it must keep to it. */
function modelsOf(
    engine: string | undefined,
    catalogue: readonly { provider: string; model: string; name: string }[],
    policies: ReadonlyMap<string, EnginePolicy>
): CodeSourceModel[] {
    const provider = engine ? core.agentCliById(engine)?.model?.provider : undefined;
    const fallback: CodeSourceModel = { provider: provider ?? "", model: null, name: "" };
    if (!engine || !provider) return [fallback];
    const policy = policies.get(engine);
    const named = (model: string) =>
        catalogue.find((entry) => entry.provider === provider && entry.model === model)?.name ?? model;
    const listed = (policy?.models ?? [])
        .filter((entry) => entry.provider === provider)
        .map((entry) => ({ provider, model: entry.model, name: named(entry.model) }));
    if (policy?.modelPolicy === "required" && listed.length > 0) return listed;
    return [
        fallback,
        ...listed,
        ...catalogue
            .filter((entry) => entry.provider === provider)
            .filter((entry) => !listed.some((other) => other.model === entry.model))
            .map((entry) => ({ provider, model: entry.model, name: entry.name }))
    ];
}

/**
 * The person's sources, from the tool-and-account rows the session start
 * already offers. One per linked account or key (however many tools read it),
 * one per vendor for a machine's own sign-in, and one per vendor the
 * deployment's environment signs in with. Own before the deployment's.
 */
export function codeSourcesFor(
    options: readonly SourceOption[],
    catalogue: readonly { provider: string; model: string; name: string }[] = [],
    policies: ReadonlyMap<string, EnginePolicy> = new Map()
): CodeSource[] {
    const accounts = new Map<string, SourceOption[]>();
    const machines: SourceOption[] = [];
    const servers: SourceOption[] = [];
    for (const option of options) {
        if (option.accountId) {
            accounts.set(option.accountId, [...(accounts.get(option.accountId) ?? []), option]);
        } else if (option.machine) {
            if (MACHINE_ENGINES.includes(option.cli)) machines.push(option);
        } else if (option.readiness === "ready" && ruleOfEngine(option.cli)) {
            servers.push(option);
        }
    }
    const sources: CodeSource[] = [];
    for (const [accountId, rows] of accounts) {
        const first = rows[0]!;
        const env = rows.find((row) => row.env)?.env ?? null;
        const rule = env ? (SOURCE_RULES[env] ?? null) : null;
        const engines = ordered(
            rows.map((row) => row.cli),
            rule
        );
        sources.push({
            key: accountSourceKey(accountId),
            kind: rule?.kind ?? (first.apiKey ? "apiKey" : "subscription"),
            label: rule?.id ?? (first.apiKey ? "otherKey" : "otherPlan"),
            vendor: rule?.vendor ?? "",
            logo: rule?.logo ?? null,
            account: first.account,
            mine: first.mine,
            readiness: rows.some((row) => row.readiness === "ready") ? "ready" : first.readiness,
            engines,
            accountId,
            machine: false,
            polarProvider: env && first.apiKey ? (POLAR_PROVIDER_OF[env] ?? null) : null,
            payer: null,
            models: modelsOf(engines[0], catalogue, policies)
        });
    }
    sources.sort((left, right) => Number(left.mine === false) - Number(right.mine === false));
    for (const option of servers) {
        const rule = ruleOfEngine(option.cli)!;
        sources.push({
            key: serverSourceKey(option.cli),
            kind: "server",
            label: rule.id,
            vendor: rule.vendor,
            logo: rule.logo,
            account: null,
            mine: false,
            readiness: option.readiness,
            engines: [option.cli],
            accountId: null,
            machine: false,
            polarProvider: null,
            payer: null,
            models: modelsOf(option.cli, catalogue, policies)
        });
    }
    for (const option of machines) {
        const rule = ruleOfEngine(option.cli);
        sources.push({
            key: machineSourceKey(option.cli),
            kind: "machine",
            label: rule?.id ?? "otherPlan",
            vendor: rule?.vendor ?? "",
            logo: rule?.logo ?? null,
            account: null,
            mine: null,
            readiness: "unknown",
            engines: [option.cli],
            accountId: null,
            machine: true,
            polarProvider: null,
            payer: null,
            models: modelsOf(option.cli, catalogue, policies)
        });
    }
    return sources;
}

/** Chat's providers as Polar sources, minus the API keys already listed as
 *  sources of their own (an Anthropic key runs on Anthropic's tool). */
export function polarSourcesFor(
    providers: readonly {
        provider: string;
        name: string;
        payers: readonly ("own" | "instance")[];
        models: readonly { provider: string; model: string; name: string }[];
    }[],
    sources: readonly CodeSource[]
): CodeSource[] {
    const covered = new Set(sources.flatMap((source) => (source.polarProvider ? [source.polarProvider] : [])));
    return providers
        .filter((provider) => !covered.has(provider.provider) && provider.models.length > 0)
        .map((provider) => {
            const payer = provider.payers[0] ?? null;
            return {
                key: polarSourceKey(provider.provider),
                kind: "polar" as const,
                label: provider.name,
                vendor: provider.name,
                logo: provider.provider,
                account: null,
                mine: payer === null ? null : payer === "own",
                readiness: "ready" as const,
                engines: [POLAR_RUNTIME, POLAR_KEYS_ENGINE],
                accountId: null,
                machine: false,
                polarProvider: provider.provider,
                payer,
                models: provider.models.map((model) => ({
                    provider: model.provider,
                    model: model.model,
                    name: model.name
                }))
            };
        });
}

/** What a session start receives, resolved from a source and a model. */
export interface ResolvedEngine {
    /** A coding tool's id, or `POLAR_RUNTIME` for an answer from Polar itself. */
    readonly cli: string;
    readonly accountId: string | null;
    readonly useMachineLogin: boolean;
    /** The model to hand it, or null for the account's default. */
    readonly modelChoice: { provider: string; model: string; payer: "own" | "instance" | null } | null;
}

/**
 * (source, model) -> engine. A Polar source answers in Polar unless the task
 * needs a session (an issue, a skill, files, one of the person's agents), then
 * runs on OpenCode with that key; a model is required there. Every other
 * source runs on its first engine, with the model only where that engine
 * takes one. Null when nothing can run the pick.
 */
export function resolveCodeEngine(
    source: Pick<CodeSource, "key" | "engines" | "accountId" | "machine" | "payer" | "polarProvider">,
    model: { provider: string; model: string | null } | null,
    { needsSession }: { needsSession: boolean }
): ResolvedEngine | null {
    if (isPolarSource(source.key)) {
        const engine = needsSession ? POLAR_KEYS_ENGINE : POLAR_RUNTIME;
        if (!source.engines.includes(engine)) return null;
        if (needsSession && !model?.model) return null;
        return {
            cli: engine,
            accountId: null,
            useMachineLogin: false,
            modelChoice: model?.model
                ? { provider: source.polarProvider ?? model.provider, model: model.model, payer: source.payer }
                : null
        };
    }
    const engine = source.engines[0];
    if (!engine) return null;
    const provider = core.agentCliById(engine)?.model?.provider ?? null;
    return {
        cli: engine,
        accountId: source.accountId,
        useMachineLogin: source.machine,
        modelChoice:
            model?.model && provider && model.provider === provider
                ? { provider, model: model.model, payer: null }
                : null
    };
}

/** A pick as the composer sends and keeps it. `model` null is the source's
 *  default; source "polar:auto" with no model is Polar's Automatic. */
export const codePickSchema = z.object({
    source: z.string().trim().min(1).max(120),
    provider: z.string().trim().max(64).default(""),
    model: z.string().trim().min(1).max(200).nullable().default(null)
});
export type CodePick = z.infer<typeof codePickSchema>;

/** Polar's Automatic: the chat picks the model per message. */
export const AUTOMATIC_PICK: CodePick = { source: polarSourceKey("auto"), provider: "auto", model: null };
export const isAutomaticPick = (pick: CodePick | null) => pick?.source === AUTOMATIC_PICK.source;

/** Where Code keeps the last pick, beside the old agent key. */
export const CODE_PICK_STORAGE_KEY = "polar.code.pick";

/** A stored pick, read back; null when absent or not one. */
export function readStoredPick(raw: string | null): CodePick | null {
    if (!raw) return null;
    try {
        const parsed = codePickSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** One of the person's own agents, as a persona over the picked model. */
export interface CodePersona {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    /** The pick the agent was set up with, when there is one. */
    readonly pick: CodePick | null;
}

/** The source an engine and account (an agent's saved work) meant. */
export function sourceForWork(
    sources: readonly CodeSource[],
    engine: string,
    account: string | null
): CodeSource | null {
    if (account === "machine") return sources.find((source) => source.key === machineSourceKey(engine)) ?? null;
    if (account) {
        const exact = sources.find((source) => source.key === accountSourceKey(account));
        if (exact) return exact;
    }
    const usable = (source: CodeSource) => source.engines[0] === engine && source.kind !== "polar";
    return (
        sources.find((source) => usable(source) && source.readiness === "ready") ??
        sources.find(usable) ??
        null
    );
}

/**
 * A pick kept before Code was model-first ("polar", "tool:<cli>",
 * "agent:<id>", or the older "<cli>:<account>"), as a source and model.
 * Polar is Automatic; a tool is its first usable source; an agent is the
 * persona plus the source it was set up with. Null when nothing matches,
 * which leaves the composer on its default rather than on a wrong source.
 */
export function migrateStoredAgent(
    stored: string,
    sources: readonly CodeSource[],
    personas: readonly CodePersona[]
): { pick: CodePick | null; persona: string | null } {
    if (!stored || stored === POLAR_RUNTIME) return { pick: stored ? AUTOMATIC_PICK : null, persona: null };
    if (stored.startsWith("agent:")) {
        const persona = personas.find((entry) => entry.id === stored.slice("agent:".length)) ?? null;
        return { pick: persona?.pick ?? null, persona: persona?.id ?? null };
    }
    const [engine = "", account = null] = (stored.startsWith("tool:") ? stored.slice("tool:".length) : stored).split(":");
    const source = sourceForWork(sources, engine, account);
    return {
        pick: source ? { source: source.key, provider: source.models[0]?.provider ?? "", model: null } : null,
        persona: null
    };
}
