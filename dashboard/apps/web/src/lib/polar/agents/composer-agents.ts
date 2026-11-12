/**
 * The agents Polar's composer offers, one row each, with what the model picker
 * beside it needs: the accounts each can sign in with and the models each may
 * use. The shape every multi-provider composer converged on (VS Code's
 * Copilot, Cursor, Zed, Conductor): the agent first, then the model, the model
 * list filtered by the agent and grouped by the account it comes from.
 *
 * Built from three things the person already has: the accounts and keys on
 * Account > AI keys (`agentOptionsFor`), their saved settings for the agents
 * that come with Polaris (`defaults.ts`), and their own agents (`store.ts`).
 *
 * Server-only.
 */

import * as core from "@polaris/core";
import { listAgents } from "@/lib/polar/agents/store";
import { latestCatalogModels } from "@/lib/agents/model-catalog";
import type { AgentOption } from "@/lib/agents/agent-readiness";
import { agentDefaultsFor, blankWork } from "@/lib/polar/agents/defaults";
import {
    customAgentKey,
    MACHINE_ACCOUNT,
    POLAR_ENGINE,
    toolAgentKey,
    type AgentModel,
    type AgentWork,
    type ModelPolicy
} from "@/lib/polar/agents/shared";

/** Models listed for one provider: newest first, enough to choose from. */
const MODELS_PER_PROVIDER = 40;

/** One way an agent can sign in. */
export interface ComposerAccount {
    /** The agent option this is (`AgentOption.key`), what a session starts with. */
    readonly key: string;
    readonly kind: "machine" | "subscription" | "apiKey" | "any";
    /** The account's own name or address; null for the machine and "any". */
    readonly label: string | null;
    readonly accountId: string | null;
    readonly machine: boolean;
    /** False when the deployment provides it. */
    readonly mine: boolean | null;
    readonly readiness: core.AgentReadiness;
}

/** A model the picker can offer. */
export interface ComposerModel {
    readonly provider: string;
    readonly model: string;
    readonly name: string;
}

export interface ComposerAgent {
    /** "polar", "tool:<cli>", or "agent:<id>". */
    readonly key: string;
    readonly kind: "polar" | "tool" | "custom";
    /** The person's own agent's id; null for the ones that come with Polaris. */
    readonly id: string | null;
    readonly name: string;
    readonly description: string;
    /** "polar" or a coding tool's id. */
    readonly engine: string;
    /** Where its models come from: Polar's keys ("polar", and a tool such as
     *  OpenCode that runs on them), the tool's own account ("own"), or nowhere
     *  Polaris can choose for it ("none"). */
    readonly modelSource: "polar" | "own" | "none";
    /** The tool's sign-ins, the agent's chosen one alone when it has one. */
    readonly accounts: readonly ComposerAccount[];
    /** The models it may use, best first; empty is any. */
    readonly models: readonly AgentModel[];
    readonly modelPolicy: ModelPolicy;
    /** For "own": the models the tool's provider offers. */
    readonly catalogue: readonly ComposerModel[];
    /** Whether anything signs it in. */
    readonly readiness: core.AgentReadiness;
}

function accountOf(option: AgentOption): ComposerAccount {
    return {
        key: option.key,
        kind: option.machine
            ? "machine"
            : option.apiKey
              ? "apiKey"
              : option.accountId
                ? "subscription"
                : "any",
        label: option.machine ? null : option.account,
        accountId: option.accountId,
        machine: option.machine,
        mine: option.mine,
        readiness: option.readiness
    };
}

function modelSourceOf(engine: string): ComposerAgent["modelSource"] {
    if (engine === POLAR_ENGINE || core.MODEL_CHOICE_AGENT_CLIS.includes(engine)) return "polar";
    return core.agentTakesModel(engine) ? "own" : "none";
}

function readinessOf(accounts: readonly ComposerAccount[]): core.AgentReadiness {
    if (accounts.some((entry) => entry.readiness === "ready")) return "ready";
    if (accounts.some((entry) => entry.readiness === "unknown")) return "unknown";
    return accounts.length > 0 ? "missing" : "unknown";
}

/** One engine an agent can run on, with everything it can sign in with and
 *  the models its provider offers. What the settings editor chooses from. */
export interface AgentEngine {
    readonly engine: string;
    readonly name: string;
    readonly modelSource: ComposerAgent["modelSource"];
    readonly accounts: readonly ComposerAccount[];
    /** For "own": the models the tool's provider offers. */
    readonly catalogue: readonly ComposerModel[];
}

/** How long the model lists are kept. They are the same for everybody and
 *  change when the catalogue is refreshed, so one read serves every composer. */
const CATALOGUE_TTL_MS = 5 * 60_000;
let cached: { at: number; models: Promise<ComposerModel[]> } | null = null;

/** The newest models of every provider a tool runs, bounded per provider. */
function toolCatalogue(): Promise<ComposerModel[]> {
    if (cached && Date.now() - cached.at < CATALOGUE_TTL_MS) return cached.models;
    const providers = [
        ...new Set(core.AGENT_CLIS.flatMap((cli) => (cli.model ? [cli.model.provider] : [])))
    ];
    const models = Promise.all(
        providers.map((provider) =>
            latestCatalogModels(provider, MODELS_PER_PROVIDER).then((rows) =>
                rows.map((model) => ({ provider, model: model.modelId, name: model.name }))
            )
        )
    ).then((lists) => lists.flat());
    cached = { at: Date.now(), models };
    // A failed read is not kept: the next composer asks again.
    models.catch(() => {
        if (cached?.models === models) cached = null;
    });
    return models;
}

/** The coding tools this machine offers, each once, in the catalogue's order. */
export async function agentEnginesFor(options: readonly AgentOption[]): Promise<AgentEngine[]> {
    const catalogue = await toolCatalogue().catch(() => []);
    const byCli = new Map<string, AgentOption[]>();
    for (const option of options) {
        byCli.set(option.cli, [...(byCli.get(option.cli) ?? []), option]);
    }
    return [...byCli.entries()].map(([engine, tool]) => {
        const provider = core.agentCliById(engine)?.model?.provider;
        return {
            engine,
            name: tool[0]?.label ?? engine,
            modelSource: modelSourceOf(engine),
            accounts: tool.map(accountOf),
            catalogue: provider ? catalogue.filter((model) => model.provider === provider) : []
        };
    });
}

/** The tool's sign-ins, narrowed to the one the agent names when it is there. */
function accountsFor(engine: AgentEngine, account: string | null): readonly ComposerAccount[] {
    if (!account) return engine.accounts;
    const picked = engine.accounts.filter((entry) =>
        account === MACHINE_ACCOUNT ? entry.machine : entry.accountId === account
    );
    // An account removed since is not a reason to offer nothing.
    return picked.length > 0 ? picked : engine.accounts;
}

export async function composerAgentsFor(
    userId: string,
    options: readonly AgentOption[]
): Promise<ComposerAgent[]> {
    const [defaults, custom, engines] = await Promise.all([
        agentDefaultsFor(userId).catch(() => new Map<string, AgentWork>()),
        listAgents(userId).catch(() => []),
        agentEnginesFor(options)
    ]);
    const toolAgent = (
        engine: AgentEngine,
        work: AgentWork,
        base: Pick<ComposerAgent, "key" | "kind" | "id" | "name" | "description">
    ): ComposerAgent => {
        const accounts = accountsFor(engine, work.account);
        return {
            ...base,
            engine: engine.engine,
            modelSource: engine.modelSource,
            accounts,
            models: work.models,
            modelPolicy: work.modelPolicy,
            catalogue: engine.catalogue,
            readiness: readinessOf(accounts)
        };
    };

    const polarWork = defaults.get(POLAR_ENGINE) ?? blankWork(POLAR_ENGINE);
    const agents: ComposerAgent[] = [
        {
            key: POLAR_ENGINE,
            kind: "polar",
            id: null,
            name: "Polar",
            description: "",
            engine: POLAR_ENGINE,
            modelSource: "polar",
            accounts: [],
            models: polarWork.models,
            modelPolicy: polarWork.modelPolicy,
            catalogue: [],
            readiness: "ready"
        }
    ];
    for (const engine of engines) {
        agents.push(
            toolAgent(engine, defaults.get(engine.engine) ?? blankWork(engine.engine), {
                key: toolAgentKey(engine.engine),
                kind: "tool",
                id: null,
                name: engine.name,
                description: ""
            })
        );
    }
    // The person's own agents that run on a coding tool. One on Polar answers
    // in Chat, where it was always started.
    for (const agent of custom) {
        const engine = engines.find((entry) => entry.engine === agent.engine);
        if (agent.engine === POLAR_ENGINE || !engine) continue;
        agents.push(
            toolAgent(engine, agent, {
                key: customAgentKey(agent.id),
                kind: "custom",
                id: agent.id,
                name: agent.name,
                description: agent.description
            })
        );
    }
    return agents;
}
