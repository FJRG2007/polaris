/**
 * The Time area - alarms and timers - as tools a connected assistant can call.
 *
 * Every change goes through `clock/service`, the module the Time screens and
 * the scheduler use, as the person the call acts for: an alarm rings at the
 * same instant, on the same devices and with the same notification as one set
 * on the screen. Alarms ring in the person's own zone, the one their calendar
 * is shown in.
 *
 * Alarms and timers are named the way the person named them - by label, or an
 * alarm by its time ("07:30"). Only an exact name is acted on; two of one name
 * are named back with their ids rather than one being guessed at.
 *
 * Reading takes `calendar.read`; setting, changing and deleting take
 * `calendar.manage`, as an event does.
 *
 * Server-only.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import * as model from "./clock/model";
import { host } from "@polaris/app-host";
import * as clock from "./clock/service";
import type { AppHostTypes } from "@polaris/app-host";
import { attempt, readerFor, refuse } from "./mcp-common";

type McpTool = AppHostTypes["McpTool"];
type McpCaller = AppHostTypes["McpCaller"];

/** Weekdays as a model writes them, in the bit order the alarm stores. */
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_WORDS = [...DAY_NAMES, "weekdays", "weekend", "every_day"] as const;

/** A day list as the stored bits. Empty is an alarm that rings once. */
export function daysToBits(days: readonly (typeof DAY_WORDS)[number][]): number {
    let bits = 0;
    for (const day of days) {
        if (day === "weekdays") bits |= model.WEEKDAYS;
        else if (day === "weekend") bits |= model.WEEKEND;
        else if (day === "every_day") bits |= model.EVERY_DAY;
        else bits |= 1 << DAY_NAMES.indexOf(day);
    }
    return bits;
}

/** The bits read back as words: "once", "every day", "weekdays", "mon, wed". */
export function bitsToDays(bits: number): string {
    if (bits === 0) return "once";
    if (bits === model.EVERY_DAY) return "every day";
    if (bits === model.WEEKDAYS) return "weekdays";
    if (bits === model.WEEKEND) return "weekend";
    return DAY_NAMES.filter((_, weekday) => model.hasDay(bits, weekday)).join(", ");
}

/** An instant as the person reads it: "Tue 07:30", in their zone. */
function onTheirClock(iso: string | null, zone: string): string | null {
    if (!iso) return null;
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).format(new Date(iso));
}

function alarmRow(alarm: model.AlarmView, zone: string) {
    return {
        id: alarm.id,
        label: alarm.label,
        time: alarm.time,
        repeats: bitsToDays(alarm.days),
        enabled: alarm.enabled,
        snoozed: alarm.snoozed,
        nextRing: onTheirClock(alarm.nextFireAt, zone),
        nextRingAt: alarm.nextFireAt
    };
}

function timerRow(timer: model.TimerView, now: number) {
    return {
        id: timer.id,
        label: timer.label,
        state: model.timerState(timer),
        length: model.formatCountdown(timer.durationMs),
        left: model.formatCountdown(model.timerRemaining(timer, now)),
        endsAt: timer.endsAt,
        focus: timer.pomodoro ? timer.pomodoro.phase : null
    };
}

/** The alarm an id, a label or a time ("07:30") means. */
function alarmNamed(alarms: readonly model.AlarmView[], wanted: string): model.AlarmView {
    const byId = alarms.find((alarm) => alarm.id === wanted);
    if (byId) return byId;
    const pick = core.pickByName(alarms, wanted, (alarm) =>
        alarm.label ? [alarm.label, alarm.time] : [alarm.time]
    );
    if (pick.kind === "one") return pick.item;
    return refuse(
        core.missedNameText(
            pick,
            wanted,
            "alarm",
            (alarm) => `${alarm.label || "(no label)"} at ${alarm.time} [${alarm.id}]`
        )
    );
}

/** The timer an id or a label means. */
function timerNamed(timers: readonly model.TimerView[], wanted: string): model.TimerView {
    const byId = timers.find((timer) => timer.id === wanted);
    if (byId) return byId;
    const pick = core.pickByName(timers, wanted, (timer) => timer.label);
    if (pick.kind === "one") return pick.item;
    return refuse(
        core.missedNameText(
            pick,
            wanted,
            "timer",
            (timer) => `${timer.label || "(no label)"} [${timer.id}]`
        )
    );
}

async function snapshotFor(caller: McpCaller) {
    const { user, zone } = await readerFor(caller);
    return { user, zone, snapshot: await clock.clockSnapshot(user.id) };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const listInput = z.object({});

const listTool = () =>
    host.mcp.defineTool({
        name: "clock_list",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "List alarms and timers",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "This account's alarms (time, days, label, next ring) and timers (label, time left, whether running), with their ids. Calendar events and task reminders are not here.",
        input: listInput,
        category: "calendar",
        scope: "calendar.read",
        readOnly: true,
        async run(_input, caller) {
            const { zone, snapshot } = await snapshotFor(caller);
            const now = Date.now();
            const alarms = snapshot.alarms.map((alarm) => alarmRow(alarm, zone));
            const timers = snapshot.timers.map((timer) => timerRow(timer, now));
            const lines = [
                ...alarms.map(
                    (alarm) =>
                        `Alarm ${alarm.time} ${alarm.repeats}${alarm.label ? ` "${alarm.label}"` : ""}: ${
                            alarm.enabled ? `next ${alarm.nextRing}` : "off"
                        }  [${alarm.id}]`
                ),
                ...timers.map(
                    (timer) =>
                        `Timer${timer.label ? ` "${timer.label}"` : ""} ${timer.length}: ${timer.state}, ${timer.left} left  [${timer.id}]`
                )
            ];
            return {
                text: lines.length > 0 ? lines.join("\n") : "No alarms or timers.",
                structured: { alarms, timers, timeZone: zone }
            };
        }
    });

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

const alarmSetInput = z.object({
    alarm: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe("To change an alarm: its id, label or time. Absent sets a new one."),
    time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Write the time as HH:mm, 24-hour")
        .optional()
        .describe("When it rings, HH:mm on the person's own clock. Needed for a new alarm."),
    days: z
        .array(z.enum(DAY_WORDS))
        .max(10)
        .optional()
        .describe(
            'The days it repeats on: "mon".."sun", "weekdays", "weekend" or "every_day". [] rings once. A new alarm without it rings once.'
        ),
    label: z.string().max(200).optional().describe("What the alarm is for."),
    snoozeMinutes: z
        .number()
        .int()
        .refine((value) => (model.SNOOZE_MINUTES as readonly number[]).includes(value), {
            message: `One of ${model.SNOOZE_MINUTES.join(", ")}`
        })
        .optional()
        .describe(`Snooze length in minutes: ${model.SNOOZE_MINUTES.join(", ")}.`),
    sound: z.enum(model.CLOCK_SOUNDS).optional().describe("The sound it rings with."),
    enabled: z.boolean().optional().describe("On or off. A new alarm is on.")
});

const alarmSetTool = () =>
    host.mcp.defineTool({
        name: "clock_alarm_set",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Set an alarm",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Set a new alarm, or change one: its time, the days it repeats, its label, snooze or sound. It rings in Polaris on the person's devices, as one set on the Time screen does. Only the fields given change.",
        input: alarmSetInput,
        category: "calendar",
        scope: "calendar.manage",
        readOnly: false,
        // Changing one overwrites what it was, so a client asks first.
        destructive: true,
        async run(input, caller) {
            const { user, zone, snapshot } = await snapshotFor(caller);
            const current = input.alarm ? alarmNamed(snapshot.alarms, input.alarm) : null;
            const time = input.time ?? current?.time;
            if (!time) refuse("Give the time a new alarm rings at, as HH:mm.");
            const parsed = model.alarmInputSchema.safeParse({
                time,
                days: input.days ? daysToBits(input.days) : (current?.days ?? 0),
                label: input.label ?? current?.label ?? "",
                sound: input.sound ?? current?.sound ?? "chime",
                snoozeMinutes: input.snoozeMinutes ?? current?.snoozeMinutes ?? 10,
                enabled: input.enabled ?? current?.enabled ?? true
            });
            if (!parsed.success) refuse("Check the alarm's label: it is too long.");
            await attempt(() => clock.saveAlarm(user.id, current?.id ?? null, parsed.data, zone));
            const after = await clock.clockSnapshot(user.id);
            const saved =
                after.alarms.find((alarm) => alarm.id === current?.id) ??
                // A new alarm: the one that was not there before.
                after.alarms.find(
                    (alarm) => !snapshot.alarms.some((before) => before.id === alarm.id)
                );
            const row = saved ? alarmRow(saved, zone) : null;
            return {
                text: row
                    ? `${current ? "Changed" : "Set"}: ${row.time} ${row.repeats}${
                          row.enabled ? `, next ring ${row.nextRing}` : ", off"
                      }.`
                    : "Saved.",
                structured: { alarm: row }
            };
        }
    });

const ALARM_ACTIONS = ["on", "off", "skip_next", "snooze", "delete"] as const;

const alarmChangeInput = z.object({
    alarm: z.string().trim().min(1).max(200).describe("The alarm: its id, label or time."),
    action: z
        .enum(ALARM_ACTIONS)
        .describe(
            "on/off; skip_next skips only its next ring; snooze rings again after its snooze length; delete removes it."
        )
});

const alarmChangeTool = () =>
    host.mcp.defineTool({
        name: "clock_alarm_change",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Turn an alarm on, off, skip, snooze or delete it",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Turn an alarm on or off, skip its next ring, snooze it, or delete it.",
        input: alarmChangeInput,
        category: "calendar",
        scope: "calendar.manage",
        readOnly: false,
        destructive: true,
        async run(input, caller) {
            const { user, snapshot } = await snapshotFor(caller);
            const alarm = alarmNamed(snapshot.alarms, input.alarm);
            await attempt(async () => {
                switch (input.action) {
                    case "on":
                    case "off":
                        return clock.setAlarmEnabled(user.id, alarm.id, input.action === "on");
                    case "skip_next":
                        return clock.skipAlarm(user.id, alarm.id);
                    case "snooze":
                        return clock.snoozeAlarm(user.id, alarm.id);
                    case "delete":
                        return clock.deleteAlarm(user.id, alarm.id);
                }
            });
            const name = alarm.label ? `"${alarm.label}" (${alarm.time})` : alarm.time;
            const done = {
                on: "On",
                off: "Off",
                skip_next: "Skipped the next ring of",
                snooze: "Snoozed",
                delete: "Deleted"
            }[input.action];
            return { text: `${done}: ${name}.`, structured: { id: alarm.id } };
        }
    });

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

const timerStartInput = z.object({
    hours: z.number().int().min(0).max(99).default(0),
    minutes: z.number().int().min(0).max(5999).default(0),
    seconds: z.number().int().min(0).max(359_999).default(0),
    label: z
        .string()
        .max(200)
        .default("")
        .describe(`What the timer is for, up to ${model.CLOCK_LABEL_MAX} characters.`),
    sound: z.enum(model.CLOCK_SOUNDS).default("chime")
});

const timerStartTool = () =>
    host.mcp.defineTool({
        name: "clock_timer_start",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Start a timer",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Start a countdown timer now, for the hours, minutes and seconds given. It rings in Polaris when it ends, as one started on the Time screen does.",
        input: timerStartInput,
        category: "calendar",
        scope: "calendar.manage",
        readOnly: false,
        destructive: false,
        async run(input, caller) {
            const { user } = await readerFor(caller);
            const durationMs = ((input.hours * 60 + input.minutes) * 60 + input.seconds) * 1000;
            const parsed = model.timerInputSchema.safeParse({
                label: input.label,
                durationMs,
                sound: input.sound,
                start: true
            });
            if (!parsed.success)
                refuse(
                    parsed.error.issues.some((issue) => issue.path[0] === "label")
                        ? `Check the timer's label: it is too long. Keep it to ${model.CLOCK_LABEL_MAX} characters.`
                        : `A timer runs from 1 second to ${model.formatClockMs(model.CLOCK_TIMER_MAX_MS)}.`
                );
            const id = await attempt(() => clock.createTimer(user.id, parsed.data));
            return {
                text: `Started a ${model.formatCountdown(durationMs)} timer${
                    input.label ? ` "${input.label}"` : ""
                }.`,
                structured: { id }
            };
        }
    });

const TIMER_ACTIONS = ["pause", "resume", "reset", "add_minute", "delete"] as const;

const timerChangeInput = z.object({
    timer: z.string().trim().min(1).max(200).describe("The timer: its id or label."),
    action: z
        .enum(TIMER_ACTIONS)
        .describe(
            "pause or resume it; reset it to its full length, stopped; add_minute adds a minute; delete removes it."
        )
});

const timerChangeTool = () =>
    host.mcp.defineTool({
        name: "clock_timer_change",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Pause, resume, reset or delete a timer",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Pause, resume, reset, add a minute to, or delete one of this account's timers.",
        input: timerChangeInput,
        category: "calendar",
        scope: "calendar.manage",
        readOnly: false,
        destructive: true,
        async run(input, caller) {
            const { user, snapshot } = await snapshotFor(caller);
            const timer = timerNamed(snapshot.timers, input.timer);
            await attempt(async () => {
                if (input.action === "delete") return clock.deleteTimer(user.id, timer.id);
                const change: clock.TimerChange =
                    input.action === "resume"
                        ? "start"
                        : input.action === "add_minute"
                          ? "addMinute"
                          : input.action;
                return clock.changeTimer(user.id, timer.id, change);
            });
            const after = (await clock.clockSnapshot(user.id)).timers.find(
                (entry) => entry.id === timer.id
            );
            return {
                text: after
                    ? `${model.timerState(after)}, ${model.formatCountdown(
                          model.timerRemaining(after, Date.now())
                      )} left.`
                    : "Deleted.",
                structured: { id: timer.id, timer: after ? timerRow(after, Date.now()) : null }
            };
        }
    });

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Alarms and timers by label or time, for `polaris_search`. */
const clockSearch = () =>
    host.mcp.defineSearch({
        id: "calendar.clock",
        app: "calendar",
        category: "calendar",
        scope: "calendar.read",
        async search(_query, caller, limit) {
            const acting = await host.mcp.actingUser(caller.userId);
            if (!acting) return [];
            const snapshot = await clock.clockSnapshot(acting.id);
            const hits: AppHostTypes["McpSearchHit"][] = [
                ...snapshot.alarms.map((alarm) => ({
                    id: alarm.id,
                    name: alarm.label || `Alarm ${alarm.time}`,
                    kind: "alarm",
                    where: `${alarm.time}, ${bitsToDays(alarm.days)}`,
                    keywords: [alarm.time, "alarm", "alarma", "despertador"],
                    next: [
                        { tool: "clock_alarm_set", args: { alarm: alarm.id } },
                        { tool: "clock_alarm_change", args: { alarm: alarm.id } }
                    ]
                })),
                ...snapshot.timers.map((timer) => ({
                    id: timer.id,
                    name: timer.label || `Timer ${model.formatCountdown(timer.durationMs)}`,
                    kind: "timer",
                    keywords: ["timer", "temporizador"],
                    next: [{ tool: "clock_timer_change", args: { timer: timer.id } }]
                }))
            ];
            return hits.slice(0, limit);
        }
    });

export function clockMcpTools(): McpTool[] {
    return [listTool, alarmSetTool, alarmChangeTool, timerStartTool, timerChangeTool].map((tool) =>
        tool()
    );
}

export function clockMcpSearch(): AppHostTypes["McpSearchProvider"][] {
    return [clockSearch()];
}
