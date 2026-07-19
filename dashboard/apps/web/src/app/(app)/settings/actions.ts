"use server";

/**
 * Settings server actions. The update check re-runs the GitHub comparison,
 * bypassing the cache, so the operator gets a fresh answer on demand. Gated to
 * admins: update state and deployment settings are operator surfaces.
 */

import { requireAdmin } from "@/lib/session";
import { getUpdateStatus, type UpdateStatus } from "@/lib/update-service";
import { createDatabaseBackup, deleteBackup, listBackups, type BackupInfo } from "@/lib/backup-service";

export async function checkUpdatesAction(): Promise<UpdateStatus> {
    await requireAdmin();
    return getUpdateStatus(true);
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

