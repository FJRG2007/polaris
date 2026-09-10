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

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import * as manage from "@/lib/backups/manage";
import * as keyring from "@/lib/backups/keyring";
import { recordAudit } from "@/lib/audit-service";
import { runBackup } from "@/lib/backups/service";
import { destinationSchema, planSchema, protectSchema, restoreSchema } from "@/lib/backups/schemas";

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
        await recordAudit({
            actorId: user.id,
            action: "backup.plan.assign",
            targetType: "backup",
            targetId: resourceId,
            metadata: { planId }
        });
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
        await recordAudit({
            actorId: user.id,
            action: paused ? "backup.pause" : "backup.resume",
            targetType: "backup",
            targetId: resourceId
        });
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
        await recordAudit({
            actorId: user.id,
            action: "backup.plan.save",
            targetType: "backup-plan",
            targetId: saved.id,
            metadata: { every: parsed.data.every, keepLast: parsed.data.keepLast, keepDays: parsed.data.keepDays }
        });
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
        await recordAudit({ actorId: user.id, action: "backup.plan.delete", targetType: "backup-plan", targetId: planId });
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
        await recordAudit({
            actorId: user.id,
            action: "backup.destination.create",
            targetType: "backup-destination",
            targetId: created.id,
            metadata: { kind: parsed.data.kind }
        });
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
        await recordAudit({
            actorId: user.id,
            action: "backup.destination.delete",
            targetType: "backup-destination",
            targetId: destinationId
        });
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
    try {
        return await manage.testDestination(user.id, destinationId);
    } catch (error) {
        // Every other action here catches, and this one has to for a reason the
        // others do not: an error thrown out of a Server Action is rethrown in the
        // React tree, so a destination that could not even be looked up did not
        // report "it did not answer" - it took the whole console down with "This
        // page stopped working", from the one button whose entire job is to find
        // out whether something is reachable.
        return { ok: false, ...failed(error) };
    }
}

const keyIdSchema = z.string().uuid("That is not a backup key");
const recoveryKeySchema = z
    .string()
    .trim()
    .min(1, "Paste the recovery key")
    .max(200, "A recovery key is shorter than that");

/** The keys this account's backups are sealed under. */
export async function listBackupKeysAction(): Promise<Result<{ keys: keyring.BackupKeyView[] }>> {
    const user = await requireAdmin();
    try {
        return { keys: await keyring.listKeys(user.id) };
    } catch (error) {
        return failed(error);
    }
}

/** Seal new copies under a fresh key; what the old one sealed still opens. */
export async function rotateBackupKeyAction(): Promise<Result<{ id: string }>> {
    const user = await requireAdmin();
    try {
        const created = await keyring.rotateKey(user.id);
        await recordAudit({ actorId: user.id, action: "backup.key.rotate", targetType: "backup-key", targetId: created.id });
        return created;
    } catch (error) {
        return failed(error);
    }
}

/**
 * One key as a recovery key, to keep somewhere this instance is not. It opens no
 * more than the account can already download - every copy comes out decrypted to
 * its owner - but it is the only thing that opens them once this database is gone,
 * so reading it is recorded.
 */
export async function revealRecoveryKeyAction(keyId: string): Promise<Result<{ recoveryKey: string }>> {
    const user = await requireAdmin();
    const parsed = keyIdSchema.safeParse(keyId);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a backup key" };
    try {
        const recoveryKey = await keyring.recoveryKey(user.id, parsed.data);
        await recordAudit({ actorId: user.id, action: "backup.key.reveal", targetType: "backup-key", targetId: parsed.data });
        return { recoveryKey };
    } catch (error) {
        return failed(error);
    }
}

/** Bring a recovery key from another Polaris, so the copies it sealed open here. */
export async function addRecoveryKeyAction(text: string): Promise<Result<{ added: boolean }>> {
    const user = await requireAdmin();
    const parsed = recoveryKeySchema.safeParse(text);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Paste the recovery key" };
    try {
        const outcome = await keyring.addRecoveryKey(user.id, parsed.data);
        await recordAudit({ actorId: user.id, action: "backup.key.add", targetType: "backup-key" });
        return outcome;
    } catch (error) {
        return failed(error);
    }
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
