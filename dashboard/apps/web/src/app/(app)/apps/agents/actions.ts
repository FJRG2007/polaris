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
import { listReposForUser } from "@/lib/github-access";
import { dispatchRun } from "@/lib/agents/agent-dispatch";
import { stopServerRun } from "@/lib/agents/agent-server-executor";
import { finishAgentRun, getAgentRun } from "@/lib/agents/agent-run-service";
import { connectedProviders, providerForModel } from "@/lib/agents/agent-providers";
import {
    agentAutomationSchema,
    agentRepoConfigSchema,
    enableAgentRepoSchema,
    manualAgentRunSchema
} from "@polaris/core";
import {
    adviseExecution,
    getAgentRepo,
    poolsServing,
    removeAgentRepo,
    setAgentRepoEnabled,
    upsertAgentRepo
} from "@/lib/agents/agent-repo-service";

const AGENTS_PATH = "/apps/agents";

/** Repositories this person can reach, for the picker. Asked as them, never with
 *  the instance's credentials: a repository list is personal. */
export async function listAgentRepoChoices(): Promise<{ repos: Array<{ fullName: string; private: boolean }>; error?: string }> {
    const user = await requirePermission("agents.manage");
    try {
        const repos = await listReposForUser(user.id);
        return { repos: repos.map((repo) => ({ fullName: repo.fullName, private: repo.private })) };
    } catch (caught) {
        return { repos: [], error: caught instanceof Error ? caught.message : "Could not read your repositories" };
    }
}

/** What Polaris advises for a repository, and which pools could serve it. */
export async function adviseRepoAction(input: unknown): Promise<{
    advice?: Awaited<ReturnType<typeof adviseExecution>>;
    pools?: Array<{ id: string; name: string }>;
    providers?: string[];
    error?: string;
}> {
    const user = await requirePermission("agents.manage");
    const parsed = z.object({ repoFullName: z.string().min(3), isPrivate: z.boolean() }).safeParse(input);
    if (!parsed.success) return { error: "Pick a repository" };
    const [advice, pools, providers] = await Promise.all([
        adviseExecution(user.id, parsed.data.repoFullName, parsed.data.isPrivate),
        poolsServing(user.id, parsed.data.repoFullName),
        connectedProviders()
    ]);
    return { advice, pools: pools.map((pool) => ({ id: pool.id, name: pool.name })), providers };
}

export async function enableRepoAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = enableAgentRepoSchema
        .extend({ isPrivate: z.boolean() })
        .safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the settings" };

    // A model whose provider is not connected produces a run that starts, asks for
    // a key, and fails. Refusing here costs a sentence instead of a failed run.
    const provider = providerForModel(parsed.data.config.model);
    if (provider && !(await connectedProviders()).includes(provider.slug)) {
        return { error: `Connect ${provider.name} under Integrations before using this model.` };
    }

    try {
        await upsertAgentRepo(user.id, {
            repoFullName: parsed.data.repoFullName,
            installationId: parsed.data.installationId,
            isPrivate: parsed.data.isPrivate,
            config: parsed.data.config
        });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not enable the repository" };
    }
    revalidatePath(AGENTS_PATH);
    revalidatePath(`${AGENTS_PATH}/repos`);
    return {};
}

export async function updateRepoConfigAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = z.object({ repoId: z.string().uuid(), config: agentRepoConfigSchema }).safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the settings" };

    const existing = await getAgentRepo(user.id, parsed.data.repoId);
    if (!existing) return { error: "Repository not found" };

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
    revalidatePath(`${AGENTS_PATH}/repos`);
    return {};
}

export async function setRepoEnabledAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = z.object({ repoId: z.string().uuid(), enabled: z.boolean() }).safeParse(input);
    if (!parsed.success) return { error: "Check the request" };
    if (!(await setAgentRepoEnabled(user.id, parsed.data.repoId, parsed.data.enabled))) {
        return { error: "Repository not found" };
    }
    revalidatePath(`${AGENTS_PATH}/repos`);
    return {};
}

export async function removeRepoAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = z.object({ repoId: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { error: "Check the request" };
    if (!(await removeAgentRepo(user.id, parsed.data.repoId))) return { error: "Repository not found" };
    revalidatePath(AGENTS_PATH);
    revalidatePath(`${AGENTS_PATH}/repos`);
    return {};
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
