"use server";

/**
 * The console's mutations.
 *
 * Every one re-resolves the session and validates its input against the shared
 * schema before touching anything, so the client is never the source of truth
 * about what may be protected, where copies go, or what may be deleted. Reads
 * are Route Handlers instead - they page, and the console fetches them after it
 * has painted.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { runBackup } from "@/lib/backups/service";
import { destinationSchema, planSchema, protectSchema, restoreSchema } from "@/lib/backups/schemas";
import * as manage from "@/lib/backups/manage";

/** What every action answers with: a sentence to show, or what it produced. */
type Result<T = object> = { error: string } | ({ error?: undefined } & T);

/** Turn a thrown failure into the sentence the dialog shows. */
function failed(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : "That did not work" };
}

export async function protectAction(input: unknown): Promise<Result<{ id: string }>> {
    const user = await requireAdmin();
    const parsed = protectSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Those details are not valid" };
    try {
        const created = await manage.protectResource(user.id, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "backup.protect",
            targetType: "backup",
            targetId: created.id
        });
        revalidatePath("/apps/backups");
        return created;
    } catch (error) {
        return failed(error);
    }
}

export async function unprotectAction(resourceId: string, deleteCopies: boolean): Promise<Result> {
    const user = await requireAdmin();
    try {
        await manage.unprotectResource(user.id, resourceId, { deleteCopies });
        await recordAudit({
            actorId: user.id,
            action: deleteCopies ? "backup.unprotect.purge" : "backup.unprotect",
            targetType: "backup",
            targetId: resourceId
        });
        revalidatePath("/apps/backups");
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function backUpNowAction(resourceId: string): Promise<Result<{ status: string }>> {
    const user = await requireAdmin();
    try {
        const outcome = await runBackup(resourceId, { trigger: "manual", actorUserId: user.id });
        revalidatePath("/apps/backups");
        return { status: outcome.status };
    } catch (error) {
        return failed(error);
    }
}

export async function setPlanAction(resourceId: string, planId: string | null): Promise<Result> {
    const user = await requireAdmin();
    try {
        await manage.setResourcePlan(user.id, resourceId, planId);
        revalidatePath("/apps/backups");
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function setPausedAction(resourceId: string, paused: boolean): Promise<Result> {
    const user = await requireAdmin();
    try {
        await manage.setResourcePaused(user.id, resourceId, paused);
        revalidatePath("/apps/backups");
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function deletePointAction(pointId: string): Promise<Result> {
    const user = await requireAdmin();
    try {
        await manage.deletePoint(user.id, pointId);
        await recordAudit({
            actorId: user.id,
            action: "backup.delete",
            targetType: "backup",
            targetId: pointId
        });
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function restoreAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    const parsed = restoreSchema.safeParse(input);
    if (!parsed.success) return { error: "Confirm the restore before it can run" };
    try {
        await manage.restoreCopy(user.id, parsed.data.copyId, user.id);
        await recordAudit({
            actorId: user.id,
            action: "backup.restore",
            targetType: "backup",
            targetId: parsed.data.copyId
        });
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function savePlanAction(input: unknown, planId?: string): Promise<Result<{ id: string }>> {
    const user = await requireAdmin();
    const parsed = planSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Those plan details are not valid" };
    try {
        const saved = await manage.savePlan(user.id, parsed.data, planId);
        revalidatePath("/apps/backups");
        return saved;
    } catch (error) {
        return failed(error);
    }
}

export async function deletePlanAction(planId: string): Promise<Result> {
    const user = await requireAdmin();
    try {
        await manage.deletePlan(user.id, planId);
        revalidatePath("/apps/backups");
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function createDestinationAction(input: unknown): Promise<Result<{ id: string }>> {
    const user = await requireAdmin();
    const parsed = destinationSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Those destination details are not valid" };
    }
    try {
        const created = await manage.createDestination(user.id, parsed.data);
        revalidatePath("/apps/backups");
        return created;
    } catch (error) {
        return failed(error);
    }
}

export async function deleteDestinationAction(destinationId: string): Promise<Result> {
    const user = await requireAdmin();
    try {
        await manage.deleteDestination(user.id, destinationId);
        revalidatePath("/apps/backups");
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function testDestinationAction(
    destinationId: string
): Promise<{ ok: boolean; error?: string; usedBytes?: number; freeBytes?: number }> {
    const user = await requireAdmin();
    return manage.testDestination(user.id, destinationId);
}

/** Store a password for a source that needs one of its own. */
export async function sealSecretAction(resourceId: string, password: string): Promise<Result> {
    await requireAdmin();
    if (!password.trim()) return { error: "Enter the password first" };
    try {
        await manage.sealResourceSecret(resourceId, { password });
        return {};
    } catch (error) {
        return failed(error);
    }
}
