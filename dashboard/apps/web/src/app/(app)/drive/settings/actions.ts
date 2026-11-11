"use server";

import { z } from "zod";
import { requirePermission } from "@/lib/session";
import {
    DRIVE_TRASH_KEEP_DAYS,
    saveDrivePreferences,
    type DrivePreferences
} from "@/lib/drive-preferences";

/** Whether moving something to the bin asks first, for the account signed in. */
export async function setConfirmTrashAction(
    raw: unknown
): Promise<DrivePreferences | { error: string }> {
    const user = await requirePermission("drive.read");
    const parsed = z.boolean().safeParse(raw);
    if (!parsed.success) return { error: "invalid" };
    return saveDrivePreferences(user.id, { confirmTrash: parsed.data });
}

/** How long something stays in the bin before it is deleted for good. */
export async function setTrashKeepDaysAction(
    raw: unknown
): Promise<DrivePreferences | { error: string }> {
    const user = await requirePermission("drive.read");
    const parsed = z
        .number()
        .int()
        .refine((days) => DRIVE_TRASH_KEEP_DAYS.includes(days))
        .safeParse(raw);
    if (!parsed.success) return { error: "invalid" };
    return saveDrivePreferences(user.id, { trashKeepDays: parsed.data });
}
