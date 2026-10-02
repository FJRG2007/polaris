"use server";

/**
 * The Time area's alarms, timers and stopwatch. Every action answers the whole
 * of the person's Time area as it now is, so a screen that changed one thing
 * shows the server's reading of everything - including a ring another device
 * already stopped.
 */

import { z } from "zod";
import * as model from "../lib/clock/model";
import * as clock from "../lib/clock/service";
import { requireCalendarUser } from "../lib/access";
import { invalid, outcome, type Outcome } from "../lib/outcome";

type Snapshot = Outcome<{ snapshot: model.ClockSnapshot }>;

const id = z.string().uuid();

async function answer(work: (userId: string) => Promise<unknown>): Promise<Snapshot> {
    return outcome(async () => {
        const user = await requireCalendarUser();
        await work(user.id);
        return { snapshot: await clock.clockSnapshot(user.id) };
    });
}

export async function loadClockAction(): Promise<Snapshot> {
    return answer(async () => undefined);
}

const saveAlarmSchema = z.object({
    id: id.nullable(),
    alarm: model.alarmInputSchema,
    zone: model.zoneSchema
});

export async function saveAlarmAction(input: unknown): Promise<Snapshot> {
    const parsed = saveAlarmSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    const { id: alarmId, alarm, zone } = parsed.data;
    return answer((userId) => clock.saveAlarm(userId, alarmId, alarm, zone));
}

const alarmChangeSchema = z.discriminatedUnion("change", [
    z.object({ id, change: z.literal("enable"), enabled: z.boolean() }),
    z.object({ id, change: z.literal("delete") }),
    z.object({ id, change: z.literal("skip") }),
    z.object({ id, change: z.literal("snooze") }),
    z.object({ id, change: z.literal("dismiss"), due: z.string().datetime() })
]);

export async function changeAlarmAction(input: unknown): Promise<Snapshot> {
    const parsed = alarmChangeSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    const request = parsed.data;
    return answer((userId) => {
        switch (request.change) {
            case "enable":
                return clock.setAlarmEnabled(userId, request.id, request.enabled);
            case "delete":
                return clock.deleteAlarm(userId, request.id);
            case "skip":
                return clock.skipAlarm(userId, request.id);
            case "snooze":
                return clock.snoozeAlarm(userId, request.id);
            case "dismiss":
                return clock.dismissAlarm(userId, request.id, new Date(request.due));
        }
    });
}

export async function createTimerAction(input: unknown): Promise<Snapshot> {
    const parsed = model.timerInputSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return answer((userId) => clock.createTimer(userId, parsed.data));
}

const focusSchema = z.object({
    config: model.pomodoroConfigSchema,
    label: z.string().max(model.CLOCK_LABEL_MAX)
});

export async function startFocusAction(input: unknown): Promise<Snapshot> {
    const parsed = focusSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return answer((userId) => clock.startFocus(userId, parsed.data.config, parsed.data.label.trim()));
}

const timerChangeSchema = z.object({
    id,
    change: z.enum(["start", "pause", "reset", "addMinute", "skip", "delete", "dismiss"])
});

export async function changeTimerAction(input: unknown): Promise<Snapshot> {
    const parsed = timerChangeSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    const { id: timerId, change } = parsed.data;
    return answer((userId) =>
        change === "delete"
            ? clock.deleteTimer(userId, timerId)
            : change === "dismiss"
              ? clock.dismissTimer(userId, timerId)
              : clock.changeTimer(userId, timerId, change)
    );
}

const stopwatchSchema = z.object({ change: z.enum(["start", "pause", "reset", "lap"]) });

export async function changeStopwatchAction(input: unknown): Promise<Snapshot> {
    const parsed = stopwatchSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return answer((userId) => clock.changeStopwatch(userId, parsed.data.change));
}
