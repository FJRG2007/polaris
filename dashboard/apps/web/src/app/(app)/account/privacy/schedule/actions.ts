"use server";

/**
 * Writing the account's own status schedule.
 *
 * Every one of these is scoped to the signed-in account by the service, not by a
 * check here: an id is a name, never a permission. Validated against the same
 * schema the form checks against, so a hand-made request cannot store a window
 * that opens on no days or ends at the minute it starts.
 */

import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { revalidatePath } from "next/cache";
import { autoPresenceSchema, presenceScheduleSchema } from "@polaris/core";
import { saveAutoPresence } from "@/lib/presence-auto-service";
import {
    createSchedule,
    deleteSchedule,
    setScheduleEnabled,
    updateSchedule
} from "@/lib/presence-schedule-service";

const PAGE = "/account/privacy/schedule";

export async function createScheduleAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = presenceScheduleSchema.safeParse(input);
    if (!parsed.success) {
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("accountPrivacy"))("schedule.notSaved")
        };
    }
    const result = await createSchedule(user.id, parsed.data);
    if (!result.error) revalidatePath(PAGE);
    return result;
}

export async function updateScheduleAction(
    id: unknown,
    input: unknown
): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = presenceScheduleSchema.safeParse(input);
    if (!parsed.success) {
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("accountPrivacy"))("schedule.notSaved")
        };
    }
    const result = await updateSchedule(user.id, String(id), parsed.data);
    if (!result.error) revalidatePath(PAGE);
    return result;
}

export async function setScheduleEnabledAction(
    id: unknown,
    enabled: unknown
): Promise<{ error?: string }> {
    const user = await requireUser();
    const result = await setScheduleEnabled(user.id, String(id), enabled === true);
    if (!result.error) revalidatePath(PAGE);
    return result;
}

export async function deleteScheduleAction(id: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const result = await deleteSchedule(user.id, String(id));
    if (!result.error) revalidatePath(PAGE);
    return result;
}

/**
 * Save automatic status. The whole setting at once, checked against the schema
 * the card checks against; calendar ids are only ever read back scoped to the
 * account's own calendars, so naming somebody else's counts for nothing.
 */
export async function saveAutoPresenceAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = autoPresenceSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("accountPrivacy"))("auto.failed") };
    await saveAutoPresence(user.id, parsed.data);
    revalidatePath(PAGE);
    return {};
}
