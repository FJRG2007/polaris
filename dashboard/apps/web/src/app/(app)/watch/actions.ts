"use server";

/**
 * Watch server actions. Reading alarms needs deploy.read; creating or changing
 * them needs deploy.manage. Input is re-validated against the shared schema.
 */

import { revalidatePath } from "next/cache";
import { requirePermission, userHasManage } from "@/lib/session";
import { nothingToShow, type Breakdown } from "@/lib/watch/breakdown-shape";
import { alarmInputSchema, type AlarmInput } from "@/lib/watch/watch-schema";
import {
    breakdownRequestSchema,
    MACHINE_PERMISSION,
    subjectBreakdown
} from "@/lib/watch/subject-breakdown";
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

/**
 * What is using one of a subject's four metrics, ranked heaviest first.
 *
 * Reading a chart needs deploy.read and so does this; the machine-wide half of
 * it - what containers are on a server, what is on its disk - is gated a second
 * time inside on the permission the Servers app gates the same readings on, so a
 * reader who may watch a server but not manage the machine gets a sentence saying
 * so rather than a list of what is on somebody's box.
 *
 * Answers rather than throws. Every ordinary failure here is a fact about the
 * subject - the machine is off, nothing was recorded in that window, this metric
 * has no parts - and the dialog says it in words.
 */
export async function subjectBreakdownAction(input: unknown): Promise<Breakdown> {
    const user = await requirePermission("deploy.read");
    const parsed = breakdownRequestSchema.safeParse(input);
    if (!parsed.success) return nothingToShow("There is nothing to break down over that window.");
    try {
        const canReadMachine = await userHasManage(user, MACHINE_PERMISSION);
        return await subjectBreakdown({ id: user.id, canReadMachine }, parsed.data);
    } catch {
        // Whatever went wrong names a host, a socket or a query. What the reader
        // can do about it is the same either way.
        return nothingToShow("Polaris could not work out what is using this just now.");
    }
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
