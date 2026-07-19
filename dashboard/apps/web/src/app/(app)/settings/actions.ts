"use server";

/**
 * Settings server actions. The update check re-runs the GitHub comparison,
 * bypassing the cache, so the operator gets a fresh answer on demand. Gated to
 * admins: update state and deployment settings are operator surfaces.
 */

import { HostdClient } from "@polaris/hostd-client";
import { requireAdmin } from "@/lib/session";
import { getUpdateStatus, type UpdateStatus } from "@/lib/update-service";
import { createDatabaseBackup, deleteBackup, listBackups, type BackupInfo } from "@/lib/backup-service";

export async function checkUpdatesAction(): Promise<UpdateStatus> {
    await requireAdmin();
    return getUpdateStatus(true);
}

/** Result of asking the host agent to update and redeploy Polaris. */
export type UpdateTrigger = "started" | "unavailable" | "disabled" | "unreachable";

/**
 * Ask the host agent (hostd) to pull the latest image and redeploy. Degrades to
 * "unreachable" when no agent is running and "unavailable" when it has no update
 * command configured, so the UI can fall back to the manual instruction.
 */
export async function triggerHostUpdateAction(): Promise<{ status: UpdateTrigger }> {
    await requireAdmin();
    try {
        const client = new HostdClient();
        if (!(await client.health())) return { status: "unreachable" };
        return { status: await client.update() };
    } catch {
        return { status: "unreachable" };
    }
}

/** Take a fresh database backup and return the updated list. */
export async function createBackupAction(): Promise<{ backups?: BackupInfo[]; error?: string }> {
    await requireAdmin();
    try {
        await createDatabaseBackup();
        return { backups: await listBackups() };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Backup failed" };
    }
}

/** Delete a backup, then return the updated list. */
export async function deleteBackupAction(name: string): Promise<{ backups: BackupInfo[] }> {
    await requireAdmin();
    await deleteBackup(name);
    return { backups: await listBackups() };
}

