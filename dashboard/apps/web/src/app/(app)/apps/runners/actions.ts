"use server";

/**
 * Runners app server actions. A pool hands one of the operator's machines to
 * GitHub, so every action here re-validates its input and re-checks the connection
 * and the machine rather than trusting what the form last saw - the page may have
 * been open since before a permission was revoked or a container engine removed.
 */

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { reconcileRunnerPools } from "@/lib/runners/runner-reconciler";
import { createRunnerPoolSchema, serverIdSchema, updateRunnerPoolSchema } from "@polaris/core";
import {
    createRunnerPool,
    deleteRunnerPool,
    probeRunnerHost,
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
        // Raising the concurrency re-checks the machine, so this can refuse with
        // something worth reading rather than only "not found".
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
