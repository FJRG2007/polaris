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
import { revalidatePath } from "next/cache";
import { presenceScheduleSchema } from "@polaris/core";
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
        return { error: parsed.error.issues[0]?.message ?? "That schedule could not be saved" };
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
        return { error: parsed.error.issues[0]?.message ?? "That schedule could not be saved" };
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
