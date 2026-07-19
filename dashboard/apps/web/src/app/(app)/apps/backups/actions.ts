"use server";

/**
 * Backups app server actions. Admin-gated: a backup is a full copy of the
 * deployment's data. The actual work lives in the backup service; these just
 * authorize and return the refreshed list.
 */

import { requireAdmin } from "@/lib/session";
import { createDatabaseBackup, deleteBackup, listBackups, type BackupInfo } from "@/lib/backup-service";

export async function createBackupAction(): Promise<{ backups?: BackupInfo[]; error?: string }> {
    await requireAdmin();
    try {
        await createDatabaseBackup();
        return { backups: await listBackups() };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Backup failed" };
    }
}

export async function deleteBackupAction(name: string): Promise<{ backups: BackupInfo[] }> {
    await requireAdmin();
    await deleteBackup(name);
    return { backups: await listBackups() };
}
