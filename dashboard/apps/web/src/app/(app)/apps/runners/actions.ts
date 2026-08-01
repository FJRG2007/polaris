"use server";

/**
 * Runners app server actions. A pool hands one of the operator's machines to
 * GitHub, so every action here re-validates its input and re-checks the connection
 * and the machine rather than trusting what the form last saw - the page may have
 * been open since before a permission was revoked or a container engine removed.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { parseGithubRepo } from "@/lib/repo-reference";
import { resolveScope } from "@/lib/runners/runner-targets";
import { listLinkedGithubAccounts } from "@/lib/github-identity";
import { reconcileRunnerPools } from "@/lib/runners/runner-reconciler";
import { createRunnerPoolSchema, runnerScopeSchema, serverIdSchema, updateRunnerPoolSchema } from "@polaris/core";
import {
    getGithubStatus,
    listGithubRepos,
    resolveGithubRepo,
    searchGithubRepos,
    type GithubRepo
} from "@/lib/github-service";
import {
    createRunnerPool,
    deleteRunnerPool,
    probeRunnerHost,
    refreshRunnerPoolTargets,
    updateRunnerPool,
    type RunnerHostReadiness
} from "@/lib/runners/runner-service";

const RUNNERS_PATH = "/apps/runners";

export async function createRunnerPoolAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = createRunnerPoolSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the pool settings" };
    try {
        await createRunnerPool(user.id, parsed.data);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the pool" };
    }
    revalidatePath(RUNNERS_PATH);
    return {};
}

export async function updateRunnerPoolAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = updateRunnerPoolSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the pool settings" };
    try {
        // Raising the concurrency re-checks the machine, and a changed scope is
        // re-checked against the connection, so this can refuse with something
        // worth reading rather than only "not found".
        if (!(await updateRunnerPool(user.id, parsed.data))) return { error: "Pool not found" };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change the pool" };
    }
    revalidatePath(RUNNERS_PATH);
    return {};
}

/** Removing a pool also stops what it left running, which can take a moment on a
 *  machine that has to be reached over SSH first. */
export async function deleteRunnerPoolAction(poolId: string): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    try {
        await deleteRunnerPool(user.id, poolId);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not remove the pool" };
    }
    revalidatePath(RUNNERS_PATH);
    return {};
}

/** Asked by the form when a server is picked, so the isolation choice and the
 *  concurrency reflect what that machine can actually do rather than what it
 *  could when it was added. */
export async function probeRunnerHostAction(
    serverId: string
): Promise<{ readiness?: RunnerHostReadiness; error?: string }> {
    const user = await requirePermission("system.manage");
    if (!serverIdSchema.safeParse(serverId).success) return { error: "Choose a server" };
    try {
        return { readiness: await probeRunnerHost(user.id, serverId) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not reach that server" };
    }
}

/** Force a reconcile instead of waiting out the interval, for an operator who
 *  just fixed whatever a pool was complaining about. */
export async function reconcileRunnersAction(): Promise<void> {
    await requirePermission("system.manage");
    await reconcileRunnerPools();
    revalidatePath(RUNNERS_PATH);
}

/** Re-read what a pool's scope comes to, for somebody who just created a
 *  repository or just had a colleague link their account. */
export async function refreshPoolTargetsAction(poolId: string): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    try {
        if (!(await refreshRunnerPoolTargets(user.id, poolId))) return { error: "Pool not found" };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not re-read the scope" };
    }
    revalidatePath(RUNNERS_PATH);
    return {};
}

/**
 * What a scope would actually come to, before it is saved.
 *
 * The form asks for this because the number matters: a scope naming an account is
 * a promise about repositories nobody has listed yet, and "this serves 34
 * repositories" is the difference between a considered choice and a surprise.
 */
export async function previewScopeAction(
    input: unknown
): Promise<{ targets?: string[]; note?: string | null; error?: string }> {
    await requirePermission("system.manage");
    const parsed = runnerScopeSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the scope" };
    try {
        const resolution = await resolveScope(parsed.data);
        return { targets: resolution.targets.map((target) => target.key), note: resolution.note };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not read that scope" };
    }
}

/** The connected GitHub account (if any) and the repositories it can register
 *  runners on, for the pool's repository picker. */
export async function githubReposAction(): Promise<{ connected: boolean; login: string | null; repos: GithubRepo[] }> {
    await requirePermission("system.manage");
    const status = await getGithubStatus();
    if (!status.connected) return { connected: false, login: null, repos: [] };
    try {
        return { connected: true, login: status.login, repos: await listGithubRepos() };
    } catch {
        return { connected: true, login: status.login, repos: [] };
    }
}

const repoQuerySchema = z.string().trim().min(2).max(200);

/**
 * Repositories matching what was typed, beyond the connected account's own list.
 * Called as the operator types, so a query GitHub will not answer - too short,
 * rate limited, no such repository - is an empty list rather than an error.
 */
export async function searchGithubReposAction(query: string): Promise<{ repos: GithubRepo[] }> {
    await requirePermission("system.manage");
    const parsed = repoQuerySchema.safeParse(query);
    if (!parsed.success) return { repos: [] };
    try {
        const reference = parseGithubRepo(parsed.data);
        if (reference) {
            const repo = await resolveGithubRepo(reference.owner, reference.repo);
            if (repo) return { repos: [repo] };
        }
        return { repos: await searchGithubRepos(parsed.data) };
    } catch {
        return { repos: [] };
    }
}

/**
 * Who a pool can be pointed at: the people who have linked a GitHub account, and
 * the groups they can be reached through.
 *
 * Only linked people are offered. Somebody who has not linked one cannot have
 * their repositories served, and listing them would offer a choice that silently
 * does nothing.
 */
export async function runnerPrincipalsAction(): Promise<{
    people: Array<{ userId: string; name: string; login: string }>;
    groups: Array<{ id: string; name: string; linked: number }>;
}> {
    await requirePermission("system.manage");
    const [linked, groups] = await Promise.all([
        listLinkedGithubAccounts(),
        prisma.group.findMany({
            select: {
                id: true,
                name: true,
                _count: { select: { members: { where: { user: { githubIdentity: { isNot: null } } } } } }
            },
            orderBy: { name: "asc" }
        })
    ]);
    return {
        people: linked.map((account) => ({ userId: account.userId, name: account.name, login: account.login })),
        groups: groups.map((group) => ({ id: group.id, name: group.name, linked: group._count.members }))
    };
}
