"use server";

import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { saveDrivePreferences, type DrivePreferences } from "@/lib/drive-preferences";

/** Whether moving something to the bin asks first, for the account signed in. */
export async function setConfirmTrashAction(raw: unknown): Promise<DrivePreferences | { error: string }> {
    const user = await requirePermission("drive.read");
    const parsed = z.boolean().safeParse(raw);
    if (!parsed.success) return { error: "invalid" };
    return saveDrivePreferences(user.id, { confirmTrash: parsed.data });
}
