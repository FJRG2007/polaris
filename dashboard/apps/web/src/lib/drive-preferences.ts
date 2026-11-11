/**
 * One person's Drive settings.
 *
 * Stored as one JSON document (`DrivePreference`). Reading fills every missing
 * or unreadable field with its default, so a setting added later is there for
 * everybody with no row to migrate, and an account that never changed anything
 * has no row at all. Writing is strict: a change is validated and a wrong value
 * is refused, never patched into a default.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { MAIL_TRASH_KEEP_CHOICES } from "@polaris/core";

/** How long something stays in the bin before it is deleted for good: the
 *  same choices as Mail's, 0 being "until I empty it". */
export const DRIVE_TRASH_KEEP_DAYS: readonly number[] = MAIL_TRASH_KEEP_CHOICES.map(
    (choice) => choice.days
);

const fields = {
    /** Whether moving something to the bin asks first. Turned off from the
     *  question itself ("Don't ask again"), and back on in Drive > Settings. */
    confirmTrash: z.boolean(),
    /** Days an item stays in the bin; 0 keeps it until the bin is emptied,
     *  which is what Drive always did, so it is the default. */
    trashKeepDays: z
        .number()
        .int()
        .refine((days) => DRIVE_TRASH_KEEP_DAYS.includes(days))
};

export const drivePreferencesSchema = z.object(fields);

export type DrivePreferences = z.infer<typeof drivePreferencesSchema>;

export const DEFAULT_DRIVE_PREFERENCES: DrivePreferences = { confirmTrash: true, trashKeepDays: 0 };

/** Every field present and valid, whatever the stored document holds. */
export function readDrivePreferences(raw: string | null | undefined): DrivePreferences {
    let parsed: unknown = {};
    try {
        parsed = raw ? JSON.parse(raw) : {};
    } catch {
        parsed = {};
    }
    const value = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    const confirmTrash = fields.confirmTrash.safeParse(value.confirmTrash);
    const trashKeepDays = fields.trashKeepDays.safeParse(value.trashKeepDays);
    return {
        confirmTrash: confirmTrash.success
            ? confirmTrash.data
            : DEFAULT_DRIVE_PREFERENCES.confirmTrash,
        trashKeepDays: trashKeepDays.success
            ? trashKeepDays.data
            : DEFAULT_DRIVE_PREFERENCES.trashKeepDays
    };
}

export async function loadDrivePreferences(userId: string): Promise<DrivePreferences> {
    const row = await prisma.drivePreference.findUnique({
        where: { userId },
        select: { value: true }
    });
    return readDrivePreferences(row?.value);
}

/** Apply a change and answer the settings as they now read. A change that
 *  leaves every value as it was writes nothing. */
export async function saveDrivePreferences(
    userId: string,
    patch: Partial<DrivePreferences>
): Promise<DrivePreferences> {
    const current = await loadDrivePreferences(userId);
    const next = drivePreferencesSchema.parse({ ...current, ...patch });
    if (
        next.confirmTrash === current.confirmTrash &&
        next.trashKeepDays === current.trashKeepDays
    )
        return current;
    const value = JSON.stringify(next);
    await prisma.drivePreference.upsert({
        where: { userId },
        create: { userId, value },
        update: { value }
    });
    return next;
}
