/**
 * What Code's composer and the agent settings choose from. The composer is
 * model-first (`codeComposerFor`, `code-sources.ts`); the settings editor
 * still sets each engine's account and models (`agentEnginesFor`).
 *
 * Originally: the agents Polar's composer offers, one row each, with what the model picker
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
import {
    codeSourcesFor,
    polarSourceKey,
    sourceForWork,
    type CodePersona,
    type CodePick,
    type CodeSource,
    type EnginePolicy
} from "@/lib/polar/agents/code-sources";
import { agentDefaultsFor, blankWork } from "@/lib/polar/agents/defaults";
import {
    POLAR_ENGINE,
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

/** What Code's composer offers: the person's sources, their own agents as
 *  personas, and the list Polar's own keys keep to. */
export interface CodeComposer {
    readonly sources: readonly CodeSource[];
    readonly personas: readonly CodePersona[];
    readonly polarPolicy: EnginePolicy;
}

export async function codeComposerFor(
    userId: string,
    options: readonly AgentOption[]
): Promise<CodeComposer> {
    const [defaults, custom, catalogue] = await Promise.all([
        agentDefaultsFor(userId).catch(() => new Map<string, AgentWork>()),
        listAgents(userId).catch(() => []),
        toolCatalogue().catch(() => [])
    ]);
    const policies = new Map<string, EnginePolicy>(
        [...defaults.entries()].map(([engine, work]) => [
            engine,
            { models: work.models, modelPolicy: work.modelPolicy }
        ])
    );
    const sources = codeSourcesFor(options, catalogue, policies);
    const personas: CodePersona[] = custom.map((agent) => {
        const first = agent.models[0];
        let pick: CodePick | null = null;
        if (agent.engine === POLAR_ENGINE) {
            pick = first
                ? { source: polarSourceKey(first.provider), provider: first.provider, model: first.model }
                : null;
        } else {
            const source = sourceForWork(sources, agent.engine, agent.account);
            pick = source
                ? {
                      source: source.key,
                      provider: source.models[0]?.provider ?? "",
                      model:
                          first && source.models.some((entry) => entry.model === first.model)
                              ? first.model
                              : null
                  }
                : null;
        }
        return { id: agent.id, name: agent.name, description: agent.description, pick };
    });
    const polarWork = defaults.get(POLAR_ENGINE) ?? blankWork(POLAR_ENGINE);
    return {
        sources,
        personas,
        polarPolicy: { models: polarWork.models, modelPolicy: polarWork.modelPolicy }
    };
}
