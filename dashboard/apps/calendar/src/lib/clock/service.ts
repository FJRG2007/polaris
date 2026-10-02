/**
 * The Time area's alarms, timers and stopwatch, kept on the server.
 *
 * Every row belongs to one person and every change is scoped to them in the
 * write itself (`where: { id, userId }`), so an id from somebody else's list
 * changes nothing - it reads as not found.
 *
 * A running timer stores when it ends and an alarm when it next rings, never a
 * count of what is left: that is what keeps them running across reloads and
 * devices, and what lets `fireDueClocks` ring them with every tab closed. A
 * ring is claimed by a conditional write on the very instant it was due, so two
 * passes - or a pass and a tab that already rang it - never ring it twice, with
 * no lease to take every few seconds.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { CalendarRefusal } from "../errors";
import { calendarTFor, type CalendarTranslator } from "../i18n";
import * as model from "./model";

/** A ring due longer ago than this - the server was down through it - is moved
 *  on without telling anybody: "your alarm rang at 07:00" at noon helps nobody. */
const STALE_MS = 60 * 60 * 1000;

/** Rows rung per pass. The next pass, seconds later, takes the rest. */
const BATCH = 200;

const ALARM_SELECT = {
    id: true,
    time: true,
    days: true,
    label: true,
    sound: true,
    snoozeMinutes: true,
    enabled: true,
    zone: true,
    nextFireAt: true,
    snoozed: true
} as const;

const TIMER_SELECT = {
    id: true,
    label: true,
    durationMs: true,
    sound: true,
    endsAt: true,
    remainingMs: true,
    firedAt: true,
    pomodoro: true
} as const;

type AlarmRow = {
    id: string;
    time: string;
    days: number;
    label: string;
    sound: string;
    snoozeMinutes: number;
    enabled: boolean;
    zone: string;
    nextFireAt: Date | null;
    snoozed: boolean;
};

type TimerRow = {
    id: string;
    label: string;
    durationMs: number;
    sound: string;
    endsAt: Date | null;
    remainingMs: number | null;
    firedAt: Date | null;
    pomodoro: string | null;
};

function alarmView(row: AlarmRow): model.AlarmView {
    return {
        id: row.id,
        time: row.time,
        days: row.days,
        label: row.label,
        sound: model.asSound(row.sound),
        snoozeMinutes: row.snoozeMinutes,
        enabled: row.enabled,
        zone: row.zone,
        nextFireAt: row.nextFireAt?.toISOString() ?? null,
        snoozed: row.snoozed
    };
}

function timerView(row: TimerRow): model.TimerView {
    return {
        id: row.id,
        label: row.label,
        durationMs: row.durationMs,
        sound: model.asSound(row.sound),
        endsAt: row.endsAt?.toISOString() ?? null,
        remainingMs: row.remainingMs,
        firedAt: row.firedAt?.toISOString() ?? null,
        pomodoro: model.readPomodoro(row.pomodoro)
    };
}

async function refusal(userId: string, key: Parameters<CalendarTranslator>[0]): Promise<never> {
    throw new CalendarRefusal((await calendarTFor(userId))(key));
}

/** Everything one person has in the Time area: at most a few dozen rows, in
 *  three indexed reads side by side. */
export async function clockSnapshot(userId: string, now = new Date()): Promise<model.ClockSnapshot> {
    const [alarms, timers, watch] = await Promise.all([
        prisma.clockAlarm.findMany({
            where: { userId },
            orderBy: [{ time: "asc" }, { createdAt: "asc" }],
            take: model.MAX_ALARMS,
            select: ALARM_SELECT
        }),
        prisma.clockTimer.findMany({
            where: { userId },
            orderBy: { createdAt: "asc" },
            take: model.MAX_TIMERS,
            select: TIMER_SELECT
        }),
        prisma.clockStopwatch.findUnique({
            where: { userId },
            select: { startedAt: true, elapsedMs: true, laps: true }
        })
    ]);
    const stopwatch: model.StopwatchView = watch
        ? {
              startedAt: watch.startedAt?.toISOString() ?? null,
              elapsedMs: watch.elapsedMs,
              laps: model.readLaps(watch.laps)
          }
        : { startedAt: null, elapsedMs: 0, laps: [] };
    return {
        alarms: alarms.map(alarmView),
        timers: timers.map(timerView),
        stopwatch,
        serverNow: now.toISOString()
    };
}

// ---------------------------------------------------------------------------
// Alarms

/** Save an alarm, new (`id` null) or changed. It rings in `zone`, the owner's. */
export async function saveAlarm(
    userId: string,
    id: string | null,
    input: model.AlarmInput,
    zone: string,
    now = new Date()
): Promise<void> {
    const data = {
        time: input.time,
        days: input.days & model.EVERY_DAY,
        label: input.label,
        sound: input.sound,
        snoozeMinutes: input.snoozeMinutes,
        enabled: input.enabled,
        zone,
        snoozed: false,
        nextFireAt: input.enabled
            ? model.nextAlarmFire({ time: input.time, days: input.days, zone }, now)
            : null
    };
    if (id === null) {
        if ((await prisma.clockAlarm.count({ where: { userId } })) >= model.MAX_ALARMS)
            await refusal(userId, "time.errors.tooManyAlarms");
        await prisma.clockAlarm.create({ data: { userId, ...data } });
        return;
    }
    const changed = await prisma.clockAlarm.updateMany({ where: { id, userId }, data });
    if (changed.count === 0) await refusal(userId, "time.errors.gone");
}

/** Turn an alarm on or off. On, it rings at its next time from now. */
export async function setAlarmEnabled(
    userId: string,
    id: string,
    enabled: boolean,
    now = new Date()
): Promise<void> {
    const alarm = await prisma.clockAlarm.findFirst({
        where: { id, userId },
        select: { time: true, days: true, zone: true }
    });
    if (!alarm) return refusal(userId, "time.errors.gone");
    await prisma.clockAlarm.updateMany({
        where: { id, userId },
        data: { enabled, snoozed: false, nextFireAt: enabled ? model.nextAlarmFire(alarm, now) : null }
    });
}

export async function deleteAlarm(userId: string, id: string): Promise<void> {
    await prisma.clockAlarm.deleteMany({ where: { id, userId } });
}

/**
 * Move an alarm past the ring due at `due` without telling anybody: a tab rang
 * it and somebody stopped it, or "Skip next" on one about to ring. Answers
 * whether this call moved it - false when the scheduler or another tab already
 * had.
 */
async function passRing(alarm: AlarmRow & { userId?: string }, due: Date, now: Date): Promise<boolean> {
    const once = alarm.days === 0;
    // A one-off is done once it has rung, unless the ring being passed is not
    // its own time but a snooze of it, which also ends it.
    const next = once ? null : model.nextAlarmFire(alarm, new Date(Math.max(now.getTime(), due.getTime())));
    const claimed = await prisma.clockAlarm.updateMany({
        where: { id: alarm.id, nextFireAt: due },
        data: { nextFireAt: next, snoozed: false, enabled: next !== null }
    });
    return claimed.count === 1;
}

async function ownAlarm(userId: string, id: string): Promise<AlarmRow> {
    const alarm = await prisma.clockAlarm.findFirst({ where: { id, userId }, select: ALARM_SELECT });
    if (!alarm) return refusal(userId, "time.errors.gone");
    return alarm;
}

/** Somebody stopped an alarm that rang in their tab at `due`. */
export async function dismissAlarm(
    userId: string,
    id: string,
    due: Date,
    now = new Date()
): Promise<void> {
    const alarm = await ownAlarm(userId, id);
    if (alarm.nextFireAt?.getTime() === due.getTime()) await passRing(alarm, due, now);
}

/** Skip the next ring of an alarm that is on, keeping the ones after it. */
export async function skipAlarm(userId: string, id: string, now = new Date()): Promise<void> {
    const alarm = await ownAlarm(userId, id);
    if (!alarm.enabled || !alarm.nextFireAt) return;
    await passRing(alarm, alarm.nextFireAt, now);
}

/** Ring again in the alarm's snooze length from now. Snoozing a ring that has
 *  already been passed on - by the server - still snoozes: the person is the
 *  one who decides they want another few minutes. */
export async function snoozeAlarm(userId: string, id: string, now = new Date()): Promise<void> {
    const alarm = await ownAlarm(userId, id);
    await prisma.clockAlarm.updateMany({
        where: { id, userId },
        data: {
            nextFireAt: new Date(now.getTime() + alarm.snoozeMinutes * 60_000),
            snoozed: true,
            enabled: true
        }
    });
}

// ---------------------------------------------------------------------------
// Timers

async function ownTimer(userId: string, id: string): Promise<TimerRow> {
    const timer = await prisma.clockTimer.findFirst({ where: { id, userId }, select: TIMER_SELECT });
    if (!timer) return refusal(userId, "time.errors.gone");
    return timer;
}

async function roomForTimer(userId: string): Promise<void> {
    if ((await prisma.clockTimer.count({ where: { userId } })) >= model.MAX_TIMERS)
        await refusal(userId, "time.errors.tooManyTimers");
}

export async function createTimer(userId: string, input: model.TimerInput, now = new Date()): Promise<string> {
    await roomForTimer(userId);
    const row = await prisma.clockTimer.create({
        data: {
            userId,
            label: input.label,
            durationMs: input.durationMs,
            sound: input.sound,
            endsAt: input.start ? new Date(now.getTime() + input.durationMs) : null
        },
        select: { id: true }
    });
    return row.id;
}

/** A focus cycle, started on its first focus phase. */
export async function startFocus(
    userId: string,
    config: model.PomodoroConfig,
    label: string,
    now = new Date()
): Promise<void> {
    await roomForTimer(userId);
    const state = model.startPomodoro(config);
    const length = model.phaseMs(state, "focus");
    await prisma.clockTimer.create({
        data: {
            userId,
            label,
            durationMs: length,
            endsAt: new Date(now.getTime() + length),
            pomodoro: JSON.stringify(state)
        }
    });
}

/** Write a timer's new state, only if it is still the one this change read. */
async function writeTimer(
    userId: string,
    timer: TimerRow,
    data: Partial<Omit<TimerRow, "id">>
): Promise<boolean> {
    const changed = await prisma.clockTimer.updateMany({
        where: { id: timer.id, userId, endsAt: timer.endsAt, remainingMs: timer.remainingMs },
        data
    });
    return changed.count === 1;
}

export type TimerChange = "start" | "pause" | "reset" | "addMinute" | "skip";

/** Start, pause, reset, add a minute to or skip the phase of a timer. */
export async function changeTimer(
    userId: string,
    id: string,
    change: TimerChange,
    now = new Date()
): Promise<void> {
    const timer = await ownTimer(userId, id);
    const at = now.getTime();
    const state = model.timerState(timer);
    let data: Partial<Omit<TimerRow, "id">> | null = null;
    if (change === "start") {
        if (state === "running") return;
        const left = state === "paused" ? timer.remainingMs! : timer.durationMs;
        data = { endsAt: new Date(at + left), remainingMs: null, firedAt: null };
    } else if (change === "pause") {
        if (state !== "running") return;
        const left = model.timerRemaining(timer, at);
        // A timer paused at zero has rung; that is the scheduler's to say.
        if (left <= 0) return;
        data = { endsAt: null, remainingMs: left };
    } else if (change === "reset") {
        const cycle = model.readPomodoro(timer.pomodoro);
        data = cycle
            ? {
                  endsAt: null,
                  remainingMs: null,
                  firedAt: null,
                  durationMs: model.phaseMs(cycle, "focus"),
                  pomodoro: JSON.stringify(model.startPomodoro(cycle))
              }
            : { endsAt: null, remainingMs: null, firedAt: null };
    } else if (change === "addMinute") {
        if (state === "running") data = { endsAt: new Date(new Date(timer.endsAt!).getTime() + 60_000) };
        else if (state === "paused") data = { remainingMs: timer.remainingMs! + 60_000 };
        // A rung timer counts down one more minute, the way a phone's "+1:00" on
        // the ringing screen does.
        else data = { endsAt: new Date(at + 60_000), firedAt: null, remainingMs: null };
    } else {
        const cycle = model.readPomodoro(timer.pomodoro);
        if (!cycle) return;
        data = phaseAdvance(cycle, now, state === "running" || cycle.auto);
    }
    if (!(await writeTimer(userId, timer, data))) await refusal(userId, "time.errors.changed");
}

export async function deleteTimer(userId: string, id: string): Promise<void> {
    await prisma.clockTimer.deleteMany({ where: { id, userId } });
}

/** A focus cycle moved to its next phase at `from`: counting already when it
 *  runs by itself (or was running), waiting for Start otherwise. */
function phaseAdvance(cycle: model.PomodoroState, from: Date, run: boolean): Partial<Omit<TimerRow, "id">> {
    const next = model.nextPhase(cycle);
    const length = model.phaseMs(next, next.phase);
    return run
        ? {
              durationMs: length,
              endsAt: new Date(from.getTime() + length),
              remainingMs: null,
              firedAt: null,
              pomodoro: JSON.stringify(next)
          }
        : {
              durationMs: length,
              endsAt: null,
              remainingMs: length,
              firedAt: from,
              pomodoro: JSON.stringify(next)
          };
}

/** What ringing a timer that ended at `due` leaves behind: a plain timer rung, a
 *  focus cycle on its next phase. */
function afterRing(timer: TimerRow, due: Date, now: Date): Partial<Omit<TimerRow, "id">> {
    const cycle = model.readPomodoro(timer.pomodoro);
    if (!cycle) return { endsAt: null, remainingMs: null, firedAt: due };
    // A phase that ended while nobody was serving it starts the next from now,
    // not from a moment that is already over.
    return phaseAdvance(cycle, due.getTime() + 60_000 < now.getTime() ? now : due, cycle.auto);
}

/** Somebody stopped a timer that rang in their tab. */
export async function dismissTimer(userId: string, id: string, now = new Date()): Promise<void> {
    const timer = await ownTimer(userId, id);
    if (timer.endsAt === null || timer.endsAt.getTime() > now.getTime()) return;
    await writeTimer(userId, timer, afterRing(timer, timer.endsAt, now));
}

// ---------------------------------------------------------------------------
// The stopwatch

export type StopwatchChange = "start" | "pause" | "reset" | "lap";

export async function changeStopwatch(
    userId: string,
    change: StopwatchChange,
    now = new Date()
): Promise<void> {
    const watch = await prisma.clockStopwatch.findUnique({
        where: { userId },
        select: { startedAt: true, elapsedMs: true, laps: true, updatedAt: true }
    });
    const current = watch ?? { startedAt: null, elapsedMs: 0, laps: "[]", updatedAt: null };
    const elapsed = model.stopwatchElapsed(current, now.getTime());
    let data: { startedAt?: Date | null; elapsedMs?: number; laps?: string };
    if (change === "start") {
        if (current.startedAt) return;
        data = { startedAt: now };
    } else if (change === "pause") {
        if (!current.startedAt) return;
        data = { startedAt: null, elapsedMs: elapsed };
    } else if (change === "reset") {
        data = { startedAt: null, elapsedMs: 0, laps: "[]" };
    } else {
        if (!current.startedAt) return;
        const laps = model.readLaps(current.laps);
        if (laps.length >= model.MAX_LAPS) await refusal(userId, "time.errors.tooManyLaps");
        data = { laps: JSON.stringify([...laps, Math.round(elapsed)]) };
    }
    if (!watch) {
        await prisma.clockStopwatch.create({
            data: { userId, startedAt: null, elapsedMs: 0, laps: "[]", ...data }
        });
        return;
    }
    // Conditional on the row this read, so two devices pressing at once cannot
    // write a lap onto a stopwatch the other just reset.
    const changed = await prisma.clockStopwatch.updateMany({
        where: { userId, updatedAt: watch.updatedAt },
        data
    });
    if (changed.count === 0) await refusal(userId, "time.errors.changed");
}

// ---------------------------------------------------------------------------
// Ringing with every tab closed

function clockTime(locale: string, zone: string, at: Date): string {
    return new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: zone }).format(at);
}

async function tell(
    userId: string,
    words: (t: CalendarTranslator, locale: string) => { title: string; body: string },
    tab: "alarms" | "timers"
): Promise<void> {
    const locale = await host.i18nLocaleService.getUserLocale(userId).catch(() => "en-US");
    const t = await calendarTFor(userId);
    const said = words(t, locale);
    await host.notificationsDispatch.notify({
        userId,
        event: "calendar.clock",
        title: said.title,
        body: said.body,
        href: `/calendar/time?tab=${tab}`
    });
}

/** Ring every alarm and timer that is due: move each on, then tell its owner. */
export async function fireDueClocks(now = new Date()): Promise<{ rung: number; late: number }> {
    let rung = 0;
    let late = 0;
    const [alarms, timers] = await Promise.all([
        prisma.clockAlarm.findMany({
            where: { nextFireAt: { lte: now } },
            orderBy: { nextFireAt: "asc" },
            take: BATCH,
            select: { ...ALARM_SELECT, userId: true }
        }),
        prisma.clockTimer.findMany({
            where: { endsAt: { lte: now } },
            orderBy: { endsAt: "asc" },
            take: BATCH,
            select: { ...TIMER_SELECT, userId: true }
        })
    ]);

    for (const alarm of alarms) {
        const due = alarm.nextFireAt!;
        if (!(await passRing(alarm, due, now))) continue;
        if (now.getTime() - due.getTime() > STALE_MS) {
            late += 1;
            continue;
        }
        rung += 1;
        await tell(
            alarm.userId,
            (t, locale) => ({
                title: alarm.label || (alarm.snoozed ? t("time.notify.snoozed") : t("time.notify.alarm")),
                body: t("time.notify.alarmBody", { time: clockTime(locale, alarm.zone, due) })
            }),
            "alarms"
        ).catch((caught: unknown) => console.error("polaris: an alarm could not be told:", caught));
    }

    for (const timer of timers) {
        const due = timer.endsAt!;
        const claimed = await prisma.clockTimer.updateMany({
            where: { id: timer.id, endsAt: due },
            data: afterRing(timer, due, now)
        });
        if (claimed.count === 0) continue;
        if (now.getTime() - due.getTime() > STALE_MS) {
            late += 1;
            continue;
        }
        rung += 1;
        const cycle = model.readPomodoro(timer.pomodoro);
        await tell(
            timer.userId,
            (t) => {
                if (!cycle) {
                    return {
                        title: timer.label || t("time.notify.timer"),
                        body: t("time.notify.timerBody")
                    };
                }
                const next = model.nextPhase(cycle);
                return {
                    title: t(`time.notify.phaseDone.${cycle.phase}`),
                    body: t(next.phase === "focus" ? "time.notify.nextFocus" : "time.notify.nextBreak", {
                        minutes: next[next.phase]
                    })
                };
            },
            "timers"
        ).catch((caught: unknown) => console.error("polaris: a timer could not be told:", caught));
    }
    return { rung, late };
}
