"use server";

/**
 * Agents app server actions.
 *
 * An agent works inside somebody's repository with credentials Polaris holds, so
 * every action re-validates its input and re-checks the connection rather than
 * trusting what the form last saw: the page may have been open since before a
 * permission was revoked, a runner pool was deleted, or a repository was made
 * public.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import type { GithubRepo } from "@/lib/github-service";
import { listReposForUser } from "@/lib/github-access";
import { dispatchRun } from "@/lib/agents/agent-dispatch";
import { MODEL_INTEGRATIONS } from "@/lib/integrations/registry";
import { stopServerRun } from "@/lib/agents/agent-server-executor";
import { syncRepoWorkflow } from "@/lib/agents/agent-workflow";
import { pickerRepoList, pickerRepoSearch } from "@/lib/github-repo-picker";
import { finishAgentRun, getAgentRun } from "@/lib/agents/agent-run-service";
import { connectedProviders, providerForModel } from "@/lib/agents/agent-providers";
import {
    listAgentDefaults,
    policyForNewRepo,
    saveAgentDefaults,
    scopeOf,
    type AgentDefaultsView
} from "@/lib/agents/agent-defaults-service";
import {
    defaultConfigFor,
    getAgentRepo,
    poolsServing,
    removeAgentRepo,
    setAgentRepoEnabled,
    upsertAgentRepo
} from "@/lib/agents/agent-repo-service";
import {
    agentAutomationSchema,
    agentDefaultsSchema,
    agentRepoConfigSchema,
    enableAgentRepoSchema,
    manualAgentRunSchema,
    policyAllowsVisibility,
    repoFullNameSchema,
    type AgentPolicy,
    type AgentRepoConfigInput,
    type ExecutionAdvice
} from "@polaris/core";

const AGENTS_PATH = "/apps/agents";

/** The model each connected provider offers, from the same catalog the AI
 *  providers screen is built from. Used only to seed a form: an operator naming
 *  another model is accepted, and an unknown one fails at dispatch naming
 *  itself. */
const MODEL_DEFAULTS: Record<string, string> = Object.fromEntries(
    MODEL_INTEGRATIONS.flatMap((entry) => (entry.defaultModel ? [[entry.slug, entry.defaultModel.slug] as const] : []))
);

/** Repositories this person can reach, for the picker. Asked as them, never with
 *  the instance's credentials: a repository list is personal. */
export async function listAgentRepoChoices(): Promise<{ connected: boolean; login: string | null; repos: GithubRepo[] }> {
    const user = await requirePermission("agents.manage");
    return pickerRepoList(user.id);
}

/** Anything the account's own list does not hold, looked up on GitHub as the
 *  operator types. */
export async function searchAgentRepoChoices(query: string): Promise<{ repos: GithubRepo[] }> {
    const user = await requirePermission("agents.manage");
    return { repos: await pickerRepoSearch(user.id, query) };
}

/**
 * Everything the repository form needs once a repository is picked.
 *
 * One call rather than four, because none of it is answerable before the
 * repository is known and all of it is needed the moment it is: what Polaris
 * advises, which pools could serve it, which model providers are connected, what
 * the tiers above it already decided, and whether those tiers allow a repository
 * of this visibility at all.
 */
export async function adviseRepoAction(input: unknown): Promise<{
    advice?: ExecutionAdvice;
    pools?: Array<{ id: string; name: string }>;
    /** Every pool this person has, so a repository no pool covers yet still says
     *  which machines exist rather than only that none does. */
    allPools?: Array<{ id: string; name: string }>;
    providers?: string[];
    defaults?: AgentRepoConfigInput;
    policy?: AgentPolicy;
    error?: string;
}> {
    const user = await requirePermission("agents.manage");
    const parsed = z.object({ repoFullName: repoFullNameSchema, isPrivate: z.boolean() }).safeParse(input);
    if (!parsed.success) return { error: "Pick a repository" };

    const [pools, allPools, providers, policy] = await Promise.all([
        poolsServing(user.id, parsed.data.repoFullName),
        prisma.runnerPool.findMany({
            where: { ownerId: user.id, enabled: true },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        }),
        connectedProviders(),
        policyForNewRepo(user.id, parsed.data.repoFullName)
    ]);

    // The first connected provider's model is only a starting point; the tiers
    // above may name one, and `defaultConfigFor` lets them win.
    const firstModel = providers.map((slug) => MODEL_DEFAULTS[slug]).find(Boolean) ?? "";
    const { advice, ...defaults } = await defaultConfigFor(
        user.id,
        parsed.data.repoFullName,
        parsed.data.isPrivate,
        firstModel
    );

    return {
        advice,
        pools: pools.map((pool) => ({ id: pool.id, name: pool.name })),
        allPools,
        providers,
        defaults,
        policy
    };
}

export async function enableRepoAction(input: unknown): Promise<{ error?: string; warning?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = enableAgentRepoSchema
        .extend({ isPrivate: z.boolean() })
        .safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the settings" };

    // The form's repository is a claim, not proof. Runs dispatch with the
    // instance's App installation token, which reaches every repository the App
    // is installed on - so without this, anybody holding `agents.manage` (which
    // `member` holds by default) could point a push-capable agent at a repository
    // they cannot even read. Checked against what this person's own linked GitHub
    // account sees, and the visibility is taken from GitHub rather than from the
    // form for the same reason: it decides the default shell policy.
    const reachable = await listReposForUser(user.id).catch(() => null);
    if (!reachable) return { error: "Polaris could not check your GitHub access. Try again in a moment." };
    const match = reachable.find((repo) => repo.fullName.toLowerCase() === parsed.data.repoFullName.toLowerCase());
    if (!match) return { error: "That repository is not one your GitHub account can reach." };

    // A model whose provider is not connected produces a run that starts, asks for
    // a key, and fails. Refusing here costs a sentence instead of a failed run.
    const provider = providerForModel(parsed.data.config.model);
    if (provider && !(await connectedProviders()).includes(provider.slug)) {
        return { error: `Connect ${provider.name} under Integrations before using this model.` };
    }

    // The visibility comes from GitHub rather than from the form, so this is the
    // real answer to a switch somebody set deliberately. Enabling a repository
    // the tiers above have turned off would produce one that looks enabled and
    // never runs.
    const policy = await policyForNewRepo(user.id, match.fullName);
    if (!policyAllowsVisibility(policy, match.private)) {
        return {
            error: match.private
                ? "Private repositories are turned off for this account. Change it under Agents settings."
                : "Public repositories are turned off for this account. Change it under Agents settings."
        };
    }

    let repoId: string;
    try {
        ({ id: repoId } = await upsertAgentRepo(user.id, {
            repoFullName: match.fullName,
            installationId: parsed.data.installationId,
            isPrivate: match.private,
            config: parsed.data.config
        }));
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not enable the repository" };
    }

    // The workflow file goes in now, not at the first run: a repository somebody
    // just added for GitHub Actions has to look configured in GitHub the moment
    // they add it, and writing it at dispatch instead left the first run racing
    // GitHub registering a file committed seconds earlier.
    const { error } = await syncRepoWorkflow({
        repoId,
        repoFullName: match.fullName,
        execution: parsed.data.config.execution,
        poolId: parsed.data.config.poolId,
        enabled: parsed.data.config.enabled
    });

    revalidatePath(AGENTS_PATH);
    revalidatePath(`${AGENTS_PATH}/repos`);
    // A warning, not a refusal: the settings are saved and correct, the
    // repository just does not carry them yet. It is on the row as well.
    return error ? { warning: error } : {};
}

export async function updateRepoConfigAction(input: unknown): Promise<{ error?: string; warning?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = z.object({ repoId: z.string().uuid(), config: agentRepoConfigSchema }).safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the settings" };

    const existing = await getAgentRepo(user.id, parsed.data.repoId);
    if (!existing) return { error: "Repository not found" };

    // Same refusal as the enable path: a model whose provider has no stored key
    // produces a run that starts, asks for one, and fails.
    const provider = providerForModel(parsed.data.config.model);
    if (provider && !(await connectedProviders()).includes(provider.slug)) {
        return { error: `Connect ${provider.name} under Integrations before using this model.` };
    }

    try {
        await upsertAgentRepo(user.id, {
            repoFullName: existing.repoFullName,
            installationId: existing.installationId,
            isPrivate: existing.isPrivate,
            config: parsed.data.config
        });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the settings" };
    }

    // A change of execution changes the file, and a move to `server` means there
    // should not be one at all.
    const { error } = await syncRepoWorkflow({
        repoId: existing.id,
        repoFullName: existing.repoFullName,
        execution: parsed.data.config.execution,
        poolId: parsed.data.config.poolId,
        enabled: parsed.data.config.enabled
    });

    revalidatePath(`${AGENTS_PATH}/repos`);
    return error ? { warning: error } : {};
}

export async function setRepoEnabledAction(input: unknown): Promise<{ error?: string; warning?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = z.object({ repoId: z.string().uuid(), enabled: z.boolean() }).safeParse(input);
    if (!parsed.success) return { error: "Check the request" };
    if (!(await setAgentRepoEnabled(user.id, parsed.data.repoId, parsed.data.enabled))) {
        return { error: "Repository not found" };
    }

    // Turning a repository off takes its workflow with it. Left behind, it is a
    // workflow anybody can still start by hand from the Actions tab against a
    // repository Polaris no longer considers enabled.
    const repo = await getAgentRepo(user.id, parsed.data.repoId);
    const { error } = repo
        ? await syncRepoWorkflow({
              repoId: repo.id,
              repoFullName: repo.repoFullName,
              execution: repo.execution,
              poolId: repo.poolId,
              enabled: parsed.data.enabled
          })
        : {};

    revalidatePath(`${AGENTS_PATH}/repos`);
    return error ? { warning: error } : {};
}

export async function removeRepoAction(input: unknown): Promise<{ error?: string; warning?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = z.object({ repoId: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { error: "Check the request" };

    // Taken out before the row goes, because afterwards there is nothing left to
    // say which repository the file was in.
    const repo = await getAgentRepo(user.id, parsed.data.repoId);
    const warning = repo
        ? (
              await syncRepoWorkflow({
                  repoId: repo.id,
                  repoFullName: repo.repoFullName,
                  execution: repo.execution,
                  poolId: repo.poolId,
                  enabled: false
              })
          ).error
        : undefined;

    if (!(await removeAgentRepo(user.id, parsed.data.repoId))) return { error: "Repository not found" };
    revalidatePath(AGENTS_PATH);
    revalidatePath(`${AGENTS_PATH}/repos`);
    return warning ? { warning } : {};
}

export async function saveAutomationAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = z
        .object({ id: z.string().uuid().optional(), repoId: z.string().uuid(), automation: agentAutomationSchema })
        .safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the rule" };

    // The repository has to be one this person owns; an id from the form is a
    // claim, not proof.
    if (!(await getAgentRepo(user.id, parsed.data.repoId))) return { error: "Repository not found" };

    const data = {
        repoId: parsed.data.repoId,
        trigger: parsed.data.automation.trigger,
        condition: JSON.stringify(parsed.data.automation.condition),
        mode: parsed.data.automation.mode,
        instructions: parsed.data.automation.instructions,
        enabled: parsed.data.automation.enabled
    };
    if (parsed.data.id) {
        await prisma.agentAutomation.updateMany({ where: { id: parsed.data.id, repoId: data.repoId }, data });
    } else {
        await prisma.agentAutomation.create({ data });
    }
    revalidatePath(`${AGENTS_PATH}/automations`);
    return {};
}

export async function removeAutomationAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { error: "Check the request" };
    await prisma.agentAutomation.deleteMany({ where: { id: parsed.data.id, repo: { ownerId: user.id } } });
    revalidatePath(`${AGENTS_PATH}/automations`);
    return {};
}

/** Start a run by hand, with a prompt the operator writes. */
export async function startRunAction(input: unknown): Promise<{ runId?: string; error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = manualAgentRunSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Say what the agent should do" };

    const repo = await prisma.agentRepo.findFirst({
        where: { ownerId: user.id, repoFullName: parsed.data.repoFullName, enabled: true }
    });
    if (!repo) return { error: "That repository is not enabled for agent runs" };

    const result = await dispatchRun({
        repo,
        trigger: "manual",
        prompt: parsed.data.prompt,
        mode: parsed.data.mode,
        issueNumber: parsed.data.issueNumber,
        startedById: user.id
    });
    revalidatePath(`${AGENTS_PATH}/runs`);
    return result.error ? { runId: result.runId, error: result.error } : { runId: result.runId };
}

/** Stop a run that is still going. */
export async function cancelRunAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = z.object({ runId: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { error: "Check the request" };

    const run = await getAgentRun(user.id, parsed.data.runId);
    if (!run) return { error: "Run not found" };

    // Only the container is ours to stop. A GitHub-scheduled job is cancelled at
    // GitHub, and saying so is better than a button that appears to work.
    if (run.execution === "server") await stopServerRun(run.id);
    await finishAgentRun(run.id, { state: "cancelled", error: "Cancelled from Polaris." });
    revalidatePath(`${AGENTS_PATH}/runs`);
    return {};
}

/**
 * The tiers above a repository, for the settings screen.
 *
 * The general tier is always returned, even when nobody has set it, so the
 * screen has a row to render rather than an empty state that hides where the
 * defaults come from.
 */
export async function listAgentDefaultsAction(): Promise<{ tiers: AgentDefaultsView[]; owners: string[] }> {
    const user = await requirePermission("agents.manage");
    const [tiers, repos] = await Promise.all([
        listAgentDefaults(user.id),
        prisma.agentRepo.findMany({ where: { ownerId: user.id }, select: { repoFullName: true } })
    ]);
    // The accounts worth offering a tier for are the ones this person actually
    // has repositories in; anything else would be a list of every organization
    // on GitHub.
    const owners = [...new Set(repos.map((repo) => scopeOf(repo.repoFullName)))].filter(Boolean).sort();
    return { tiers, owners };
}

/** Store one tier. A tier that decides nothing is removed rather than kept. */
export async function saveAgentDefaultsAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = agentDefaultsSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the settings" };

    // Same refusal as the repository paths: a model whose provider has no stored
    // key produces runs that start, ask for one, and fail - and here it would do
    // that to every repository the tier covers.
    if (parsed.data.model) {
        const provider = providerForModel(parsed.data.model);
        if (provider && !(await connectedProviders()).includes(provider.slug)) {
            return { error: `Connect ${provider.name} under Integrations before defaulting to this model.` };
        }
    }

    // A pool from a form is a claim. Storing one this person does not own would
    // point every repository under the tier at somebody else's machine.
    if (parsed.data.poolId) {
        const pool = await prisma.runnerPool.findFirst({
            where: { id: parsed.data.poolId, ownerId: user.id },
            select: { id: true }
        });
        if (!pool) return { error: "That runner pool is not one of yours." };
    }

    try {
        await saveAgentDefaults(user.id, parsed.data);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the settings" };
    }
    revalidatePath(`${AGENTS_PATH}/settings`);
    revalidatePath(`${AGENTS_PATH}/repos`);
    return {};
}
