/**
 * The Time area's alarms, timers and stopwatch as plain values: what each one
 * is, when it rings next, where a focus cycle goes after each phase, and what
 * the screens send to change them.
 *
 * Pure: shared by the screens, the server actions and the scheduler, so the
 * time a screen shows for "next ring" is the time the server rings it.
 */

import { z } from "zod";
import { cleanText, isKnownZone } from "../schemas";
import { CLOCK_LABEL_MAX, CLOCK_TIMER_MAX_MS } from "@polaris/core";
import { instantToWall, wallToInstant, type WallTime } from "../../engine";

export { CLOCK_LABEL_MAX, CLOCK_TIMER_MAX_MS };

/** The sounds a ring can make, drawn in the browser (see `screens/clock/sound`). */
export const CLOCK_SOUNDS = ["chime", "bell", "beep", "digital", "gentle"] as const;
export type ClockSound = (typeof CLOCK_SOUNDS)[number];

export const SNOOZE_MINUTES = [1, 5, 10, 15, 20, 30] as const;

/** How many of each one person may keep. Bounded so a list is one small read. */
export const MAX_ALARMS = 50;
export const MAX_TIMERS = 30;
export const MAX_LAPS = 500;

/** Weekdays as bits, Sunday first: `1 << 0` is Sunday, `1 << 6` Saturday. */
export const EVERY_DAY = 0b1111111;
export const WEEKDAYS = 0b0111110;
export const WEEKEND = 0b1000001;

export function hasDay(days: number, weekday: number): boolean {
    return (days & (1 << weekday)) !== 0;
}

export function toggleDay(days: number, weekday: number): number {
    return days ^ (1 << weekday);
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const label = z.string().max(200).transform(cleanText).pipe(z.string().max(CLOCK_LABEL_MAX));
const zone = z.string().trim().min(1).max(64).refine(isKnownZone);

export const alarmInputSchema = z.object({
    time: hhmm,
    days: z.number().int().min(0).max(EVERY_DAY),
    label,
    sound: z.enum(CLOCK_SOUNDS),
    snoozeMinutes: z
        .number()
        .int()
        .refine((value) => (SNOOZE_MINUTES as readonly number[]).includes(value)),
    enabled: z.boolean()
});

export type AlarmInput = z.infer<typeof alarmInputSchema>;

export const timerInputSchema = z.object({
    label,
    durationMs: z.number().int().min(1000).max(CLOCK_TIMER_MAX_MS),
    sound: z.enum(CLOCK_SOUNDS),
    /** Start counting straight away, rather than wait for Start. */
    start: z.boolean()
});

export type TimerInput = z.infer<typeof timerInputSchema>;

/** A focus cycle's lengths, in minutes, and whether each phase starts the next. */
export const pomodoroConfigSchema = z.object({
    focus: z.number().int().min(1).max(180),
    short: z.number().int().min(1).max(60),
    long: z.number().int().min(1).max(120),
    /** Focus phases before the long break. */
    rounds: z.number().int().min(2).max(12),
    /** Each phase starts the next by itself, the way Windows' focus sessions do. */
    auto: z.boolean()
});

export type PomodoroConfig = z.infer<typeof pomodoroConfigSchema>;

export const DEFAULT_POMODORO: PomodoroConfig = {
    focus: 25,
    short: 5,
    long: 15,
    rounds: 4,
    auto: true
};

export const POMODORO_PHASES = ["focus", "short", "long"] as const;
export type PomodoroPhase = (typeof POMODORO_PHASES)[number];

/** A focus cycle as a timer carries it: its lengths and where it is. */
export const pomodoroStateSchema = pomodoroConfigSchema.extend({
    phase: z.enum(POMODORO_PHASES),
    /** Which focus phase of the cycle this is, or the one a break follows. */
    round: z.number().int().min(1).max(12),
    /** Focus phases finished since it started, for the "3 done today" line. */
    done: z.number().int().min(0).max(10_000)
});

export type PomodoroState = z.infer<typeof pomodoroStateSchema>;

export const zoneSchema = zone;

/** The length of a phase, in milliseconds. */
export function phaseMs(state: Pick<PomodoroState, PomodoroPhase>, phase: PomodoroPhase): number {
    return state[phase] * 60_000;
}

/**
 * Where a cycle goes when a phase ends: focus -> short break, except after the
 * last round, which earns the long one; any break -> the next focus, and the
 * long break starts the cycle over.
 */
export function nextPhase(state: PomodoroState): PomodoroState {
    if (state.phase === "focus") {
        const done = state.done + 1;
        return state.round >= state.rounds
            ? { ...state, phase: "long", done }
            : { ...state, phase: "short", done };
    }
    if (state.phase === "short") return { ...state, phase: "focus", round: state.round + 1 };
    return { ...state, phase: "focus", round: 1 };
}

/** A new cycle, on its first focus phase. */
export function startPomodoro(config: PomodoroConfig): PomodoroState {
    return { ...config, phase: "focus", round: 1, done: 0 };
}

/** A stored cycle, or null when it does not read - a plain timer, then. */
export function readPomodoro(raw: string | null | undefined): PomodoroState | null {
    if (!raw) return null;
    try {
        const parsed = pomodoroStateSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function wallOfDay(instant: Date, zoneName: string, offsetDays: number): WallTime {
    const wall = instantToWall(instant, zoneName);
    const day = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + offsetDays));
    return {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0
    };
}

/**
 * The next instant after `after` an alarm rings: its wall time in its zone, on
 * the next day it repeats on - or on the next day at all for a one-off.
 *
 * Read through the calendar engine, which settles the two awkward nights the
 * way RFC 5545 does: a time the spring change skips rings at the same distance
 * past the gap (02:30 becomes 03:30), and a time the autumn change repeats
 * rings once, the first time.
 */
export function nextAlarmFire(
    alarm: { readonly time: string; readonly days: number; readonly zone: string },
    after: Date
): Date {
    const [hour, minute] = alarm.time.split(":").map(Number) as [number, number];
    // Eight days covers a weekly alarm whose only day is today, already past.
    for (let offset = 0; offset <= 8; offset++) {
        const day = wallOfDay(after, alarm.zone, offset);
        const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
        if (alarm.days !== 0 && !hasDay(alarm.days, weekday)) continue;
        const at = wallToInstant({ ...day, hour, minute }, alarm.zone);
        if (at.getTime() > after.getTime()) return at;
    }
    // Unreachable for a valid alarm: eight days always hold one of its days.
    throw new Error(`No next ring for ${alarm.time} on ${alarm.days}`);
}

/** What a timer is doing. */
export type TimerState = "running" | "paused" | "rung" | "idle";

export interface TimerFields {
    readonly durationMs: number;
    readonly endsAt: Date | string | null;
    readonly remainingMs: number | null;
    readonly firedAt: Date | string | null;
}

const ms = (value: Date | string) => (value instanceof Date ? value : new Date(value)).getTime();

export function timerState(timer: TimerFields): TimerState {
    if (timer.endsAt !== null) return "running";
    if (timer.remainingMs !== null) return "paused";
    if (timer.firedAt !== null) return "rung";
    return "idle";
}

/** What is left on a timer at `now`, never below zero. */
export function timerRemaining(timer: TimerFields, now: number): number {
    if (timer.endsAt !== null) return Math.max(0, ms(timer.endsAt) - now);
    if (timer.remainingMs !== null) return timer.remainingMs;
    if (timer.firedAt !== null) return 0;
    return timer.durationMs;
}

export interface StopwatchFields {
    readonly startedAt: Date | string | null;
    readonly elapsedMs: number;
}

/** The stopwatch's reading at `now`. */
export function stopwatchElapsed(watch: StopwatchFields, now: number): number {
    return (
        watch.elapsedMs + (watch.startedAt === null ? 0 : Math.max(0, now - ms(watch.startedAt)))
    );
}

/** Each lap's own length from the running totals stored for them. */
export function lapSplits(totals: readonly number[]): number[] {
    return totals.map((total, index) => total - (index === 0 ? 0 : totals[index - 1]!));
}

/** The laps stored as JSON, or none when they do not read. */
export function readLaps(raw: string | null | undefined): number[] {
    try {
        const parsed: unknown = JSON.parse(raw ?? "[]");
        return Array.isArray(parsed)
            ? parsed.filter((value): value is number => typeof value === "number" && value >= 0)
            : [];
    } catch {
        return [];
    }
}

/** "1:02:03.45" or "02:03.45": a stopwatch or timer reading. */
export function formatClockMs(value: number, options: { hundredths?: boolean } = {}): string {
    const total = Math.max(0, Math.floor(value));
    const hours = Math.floor(total / 3_600_000);
    const minutes = Math.floor((total % 3_600_000) / 60_000);
    const seconds = Math.floor((total % 60_000) / 1000);
    const pad = (part: number) => String(part).padStart(2, "0");
    const head =
        hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
    return options.hundredths ? `${head}.${pad(Math.floor((total % 1000) / 10))}` : head;
}

/** A timer's face, counting down: whole seconds rounded up, so it shows 00:01
 *  until it really is zero. */
export function formatCountdown(value: number): string {
    return formatClockMs(Math.ceil(Math.max(0, value) / 1000) * 1000);
}

// ---------------------------------------------------------------------------
// The wire: what the server answers and the screens hold.

export interface AlarmView {
    readonly id: string;
    readonly time: string;
    readonly days: number;
    readonly label: string;
    readonly sound: ClockSound;
    readonly snoozeMinutes: number;
    readonly enabled: boolean;
    readonly zone: string;
    readonly nextFireAt: string | null;
    readonly snoozed: boolean;
}

export interface TimerView {
    readonly id: string;
    readonly label: string;
    readonly durationMs: number;
    readonly sound: ClockSound;
    readonly endsAt: string | null;
    readonly remainingMs: number | null;
    readonly firedAt: string | null;
    readonly pomodoro: PomodoroState | null;
}

export interface StopwatchView {
    readonly startedAt: string | null;
    readonly elapsedMs: number;
    /** Running totals at each lap. */
    readonly laps: readonly number[];
}

export interface ClockSnapshot {
    readonly alarms: readonly AlarmView[];
    readonly timers: readonly TimerView[];
    readonly stopwatch: StopwatchView;
    /** The server's clock when this was read, so a screen on a device whose own
     *  clock is off still counts down to the same second. */
    readonly serverNow: string;
}

export const EMPTY_STOPWATCH: StopwatchView = { startedAt: null, elapsedMs: 0, laps: [] };

export function asSound(value: string): ClockSound {
    return (CLOCK_SOUNDS as readonly string[]).includes(value) ? (value as ClockSound) : "chime";
}
