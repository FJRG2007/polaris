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
    z.object({ id, change: z.literal("snooze"), due: z.string().datetime().optional() }),
    z.object({ id, change: z.literal("dismiss"), due: z.string().datetime() }),
    z.object({ id, change: z.literal("rename"), label: model.alarmInputSchema.shape.label }),
    z.object({ id, change: z.literal("duplicate") })
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
                return clock.snoozeAlarm(
                    userId,
                    request.id,
                    new Date(),
                    request.due ? new Date(request.due) : undefined
                );
            case "dismiss":
                return clock.dismissAlarm(userId, request.id, new Date(request.due));
            case "rename":
                return clock.renameAlarm(userId, request.id, request.label);
            case "duplicate":
                return clock.duplicateAlarm(userId, request.id);
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
    return answer((userId) =>
        clock.startFocus(userId, parsed.data.config, parsed.data.label.trim())
    );
}

const timerChangeSchema = z.object({
    id,
    change: z.enum([
        "start",
        "pause",
        "reset",
        "addMinute",
        "skip",
        "delete",
        "dismiss",
        "duplicate"
    ]),
    /** The ring a "dismiss" stops, by when it was due. */
    due: z.string().datetime().optional()
});

export async function changeTimerAction(input: unknown): Promise<Snapshot> {
    const parsed = timerChangeSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    const { id: timerId, change, due } = parsed.data;
    return answer((userId) =>
        change === "delete"
            ? clock.deleteTimer(userId, timerId)
            : change === "duplicate"
              ? clock.duplicateTimer(userId, timerId)
              : change === "dismiss"
                ? clock.dismissTimer(userId, timerId, new Date(), due ? new Date(due) : undefined)
                : clock.changeTimer(userId, timerId, change)
    );
}

const editTimerSchema = z.object({
    id,
    label: model.timerInputSchema.shape.label,
    sound: model.timerInputSchema.shape.sound.optional(),
    durationMs: model.timerInputSchema.shape.durationMs.optional()
});

/** Rename a timer, change its sound or its length. */
export async function editTimerAction(input: unknown): Promise<Snapshot> {
    const parsed = editTimerSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    const { id: timerId, ...edit } = parsed.data;
    return answer((userId) => clock.editTimer(userId, timerId, edit));
}

const sendCopySchema = z.object({
    kind: z.enum(["alarm", "timer"]),
    id,
    to: z.string().trim().min(1).max(64)
});

/** Send a copy of an alarm or a timer to another person here. */
export async function sendClockCopyAction(input: unknown): Promise<Snapshot> {
    const parsed = sendCopySchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    const { kind, id: itemId, to } = parsed.data;
    return outcome(async () => {
        const user = await requireCalendarUser();
        await clock.sendCopy(user, kind, itemId, to);
        return { snapshot: await clock.clockSnapshot(user.id) };
    });
}

const stopwatchSchema = z.object({ change: z.enum(["start", "pause", "reset", "lap"]) });

export async function changeStopwatchAction(input: unknown): Promise<Snapshot> {
    const parsed = stopwatchSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return answer((userId) => clock.changeStopwatch(userId, parsed.data.change));
}
