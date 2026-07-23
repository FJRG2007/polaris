"use server";

/**
 * Watch server actions. Reading alarms needs deploy.read; creating or changing
 * them needs deploy.manage. Input is re-validated against the shared schema.
 */

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { alarmInputSchema, type AlarmInput } from "@/lib/watch/watch-schema";
import {
    createAlarm,
    deleteAlarm,
    listAlarms,
    listAlarmTargets,
    listRecentAlarmEvents,
    setAlarmEnabled,
    type AlarmEventView,
    type AlarmTargets,
    type AlarmView
} from "@/lib/watch-service";

export async function watchStateAction(): Promise<{
    alarms: AlarmView[];
    events: AlarmEventView[];
    targets: AlarmTargets;
}> {
    const user = await requirePermission("deploy.read");
    const [alarms, events, targets] = await Promise.all([
        listAlarms(user.id),
        listRecentAlarmEvents(user.id),
        listAlarmTargets(user.id)
    ]);
    return { alarms, events, targets };
}

export async function createAlarmAction(input: AlarmInput): Promise<{ error?: string; id?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = alarmInputSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };
    try {
        const id = await createAlarm(user.id, parsed.data);
        revalidatePath("/watch");
        return { id };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the alarm" };
    }
}

export async function setAlarmEnabledAction(id: string, enabled: boolean): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await setAlarmEnabled(user.id, id, enabled);
        revalidatePath("/watch");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the alarm" };
    }
}

export async function deleteAlarmAction(id: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deleteAlarm(user.id, id);
        revalidatePath("/watch");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not delete the alarm" };
    }
}
