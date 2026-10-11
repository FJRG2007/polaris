/**
 * A kept command run later, or again and again: once at a time, every so many
 * minutes, or a number of times with a gap between them.
 *
 * Kept on the install beside the commands themselves, so it survives a restart
 * of the dashboard and is the same for everybody who runs the server. The sweep
 * that fires it is the minute-by-minute pass every game server already gets
 * (`games-jobs`), so there is no timer of its own to lose.
 *
 * A schedule carries a copy of the command and the values it was given, not a
 * pointer to the kept one: what was scheduled is what runs, even if the button
 * is edited afterwards. Forgetting the kept command ends its schedules.
 *
 * A moment that passes while the server is down is skipped and shown as skipped,
 * never queued: ten restarts' worth of "every five minutes" arriving at once when
 * the server comes back is nobody's idea of a schedule.
 *
 * Pure: the schedule math and the reading of the stored list.
 */

import { z } from "zod";
import { gameMessage } from "./game-message";
import { readCustomVariables, type CustomVariable, type RunTarget } from "./console-vars";

export type ScheduleRepeat =
    | { readonly kind: "once" }
    | { readonly kind: "every"; readonly minutes: number }
    | { readonly kind: "times"; readonly minutes: number; readonly times: number };

export type ScheduleOutcome = "ran" | "failed" | "skipped";

export interface ScheduleRun {
    readonly at: string;
    readonly outcome: ScheduleOutcome;
    /** Why it failed or was skipped, as a carried message; empty when it ran. */
    readonly detail: string;
}

export interface ConsoleSchedule {
    readonly id: string;
    /** The kept command it was made from, so forgetting that one ends this. */
    readonly commandId: string;
    readonly label: string;
    readonly command: string;
    readonly variables: readonly CustomVariable[];
    readonly values: Readonly<Record<string, string>>;
    /** Who a per-player command is written for; null for one that is not. */
    readonly target: RunTarget | null;
    readonly repeat: ScheduleRepeat;
    /** The next moment it fires, ISO; null once it has nothing left to do. */
    readonly nextAt: string | null;
    /** Moments that have come, run or skipped. */
    readonly done: number;
    readonly skipped: number;
    readonly last: ScheduleRun | null;
    /** Who set it up, for the audit line each run writes. */
    readonly createdBy: string;
}

export const CONSOLE_SCHEDULES_KEY = "consoleSchedules";
export const MAX_CONSOLE_SCHEDULES = 20;
/** The sweep runs once a minute, so nothing finer means anything. */
export const MIN_EVERY_MINUTES = 1;
export const MAX_EVERY_MINUTES = 7 * 24 * 60;
export const MIN_TIMES = 2;
export const MAX_TIMES = 1000;
/** How far ahead a first run may be set. */
export const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
/** How late a sweep may be and still run the moment rather than skip it: the
 *  box was busy for a few minutes, not asleep for an hour. */
export const GRACE_MS = 10 * 60 * 1000;

const MINUTE = 60 * 1000;

/**
 * The units a gap or a delay is typed in. Whole minutes and up, never seconds:
 * the sweep that fires a schedule runs once a minute, so "in 30 seconds" or
 * "every 20 seconds" would be a promise it breaks on every run.
 */
export const SPAN_UNITS = ["minutes", "hours", "days"] as const;
export type SpanUnit = (typeof SPAN_UNITS)[number];

const UNIT_MINUTES: Readonly<Record<SpanUnit, number>> = { minutes: 1, hours: 60, days: 24 * 60 };

/** So many minutes, hours or days, as somebody types them. */
export interface Span {
    readonly amount: number;
    readonly unit: SpanUnit;
}

/** The quick "in ..." choices for a first run, in minutes. */
export const START_PRESETS = [1, 5, 15, 60] as const;

/** The longest "in ..." a first run may be set for, in minutes. */
export const MAX_START_IN_MINUTES = MAX_AHEAD_MS / MINUTE;

export function spanMinutes(span: Span): number {
    return span.amount * UNIT_MINUTES[span.unit];
}

/** The largest unit a number of minutes is a whole count of, for showing it. */
export function spanOf(minutes: number): Span {
    if (minutes % UNIT_MINUTES.days === 0)
        return { amount: minutes / UNIT_MINUTES.days, unit: "days" };
    if (minutes % UNIT_MINUTES.hours === 0)
        return { amount: minutes / UNIT_MINUTES.hours, unit: "hours" };
    return { amount: minutes, unit: "minutes" };
}

/** A whole number of units from one up, adding up to no more than `max` minutes. */
function spanSchema(max: number, message: () => string) {
    return z
        .object({
            amount: z.number({ invalid_type_error: message() }).int(message()).min(1, message()),
            unit: z.enum(SPAN_UNITS)
        })
        .strict()
        .refine((span) => spanMinutes(span) <= max, { message: message() });
}

/** "Every N ..." as typed: the gap the repeat is stored with, in whole minutes. */
export const everySchema = spanSchema(MAX_EVERY_MINUTES, () =>
    gameMessage("games", "consoleSchedule.errors.every")
);

/** "In N ..." as typed: how long from now the first run is. Checked on both
 *  sides and turned into a moment by the server, on the server's clock. */
export const startInSchema = spanSchema(MAX_START_IN_MINUTES, () =>
    gameMessage("games", "consoleSchedule.errors.startIn")
);

/** What is wrong with a span as typed against one of the schemas above, as a
 *  carried message, or null. */
export function spanProblem(schema: typeof everySchema, span: Span): string | null {
    const checked = schema.safeParse(span);
    return checked.success ? null : (checked.error.issues[0]?.message ?? null);
}

/** The first moment an "in ..." names, counted from `now`. */
export function startAfter(span: Span, now: Date): Date {
    return new Date(now.getTime() + spanMinutes(span) * MINUTE);
}

/** Whether it still has a moment to come. */
export function isActive(schedule: ConsoleSchedule): boolean {
    return schedule.nextAt !== null;
}

/** What is wrong with a repeat as typed, as a carried message, or null. */
export function repeatProblem(repeat: ScheduleRepeat): string | null {
    if (repeat.kind === "once") return null;
    if (
        !Number.isInteger(repeat.minutes) ||
        repeat.minutes < MIN_EVERY_MINUTES ||
        repeat.minutes > MAX_EVERY_MINUTES
    ) {
        return gameMessage("games", "consoleSchedule.errors.every");
    }
    if (
        repeat.kind === "times" &&
        (!Number.isInteger(repeat.times) || repeat.times < MIN_TIMES || repeat.times > MAX_TIMES)
    ) {
        return gameMessage("games", "consoleSchedule.errors.times", {
            min: MIN_TIMES,
            max: MAX_TIMES
        });
    }
    return null;
}

/** What is wrong with a first moment, as a carried message, or null. A moment a
 *  minute in the past is "now" typed slowly, not a mistake. */
export function startProblem(firstAt: Date, now: Date): string | null {
    const at = firstAt.getTime();
    if (Number.isNaN(at)) return gameMessage("games", "consoleSchedule.errors.when");
    if (at < now.getTime() - MINUTE) return gameMessage("games", "consoleSchedule.errors.past");
    if (at > now.getTime() + MAX_AHEAD_MS)
        return gameMessage("games", "consoleSchedule.errors.far");
    return null;
}

/** What one sweep does with a schedule. */
export interface Advance {
    /** Whether this sweep runs the command. */
    readonly fire: boolean;
    /** The schedule with its moments counted and its next one set. `last` is
     *  left for the caller, who knows how the run went. */
    readonly next: ConsoleSchedule;
}

/**
 * Where a schedule stands at `now`.
 *
 * Every moment between the one it was waiting for and now has come. The newest
 * of them runs if it is no more than `GRACE_MS` old; every other one is skipped.
 * A schedule that is not due yet comes back unchanged.
 */
export function advance(schedule: ConsoleSchedule, now: Date, graceMs = GRACE_MS): Advance {
    const waiting = schedule.nextAt === null ? Number.NaN : Date.parse(schedule.nextAt);
    if (Number.isNaN(waiting) || now.getTime() < waiting) return { fire: false, next: schedule };

    const repeat = schedule.repeat;
    const step = repeat.kind === "once" ? 0 : repeat.minutes * MINUTE;
    let passed = step === 0 ? 1 : Math.floor((now.getTime() - waiting) / step) + 1;
    if (repeat.kind === "times")
        passed = Math.min(passed, Math.max(repeat.times - schedule.done, 0));
    if (passed <= 0) return { fire: false, next: { ...schedule, nextAt: null } };

    const newest = waiting + (passed - 1) * step;
    const fire = now.getTime() - newest <= graceMs;
    const done = schedule.done + passed;
    const ended = repeat.kind === "once" || (repeat.kind === "times" && done >= repeat.times);
    return {
        fire,
        next: {
            ...schedule,
            done,
            skipped: schedule.skipped + passed - (fire ? 1 : 0),
            nextAt: ended ? null : new Date(waiting + passed * step).toISOString(),
            last: fire
                ? schedule.last
                : {
                      at: now.toISOString(),
                      outcome: "skipped",
                      detail: gameMessage("games", "consoleSchedule.missed")
                  }
        }
    };
}

function readRepeat(raw: unknown): ScheduleRepeat | null {
    if (typeof raw !== "object" || raw === null) return null;
    const row = raw as Record<string, unknown>;
    const repeat: ScheduleRepeat | null =
        row.kind === "once"
            ? { kind: "once" }
            : row.kind === "every" && typeof row.minutes === "number"
              ? { kind: "every", minutes: row.minutes }
              : row.kind === "times" &&
                  typeof row.minutes === "number" &&
                  typeof row.times === "number"
                ? { kind: "times", minutes: row.minutes, times: row.times }
                : null;
    return repeat && repeatProblem(repeat) === null ? repeat : null;
}

function readTarget(raw: unknown): RunTarget | null {
    if (typeof raw !== "object" || raw === null) return null;
    const row = raw as Record<string, unknown>;
    if (row.every === true) return { every: true };
    return typeof row.player === "string" ? { player: row.player } : null;
}

function readRun(raw: unknown): ScheduleRun | null {
    if (typeof raw !== "object" || raw === null) return null;
    const row = raw as Record<string, unknown>;
    if (
        typeof row.at !== "string" ||
        !["ran", "failed", "skipped"].includes(row.outcome as string)
    ) {
        return null;
    }
    return {
        at: row.at,
        outcome: row.outcome as ScheduleOutcome,
        detail: typeof row.detail === "string" ? row.detail : ""
    };
}

const count = (value: unknown): number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

/** The list as the install recorded it; anything unreadable is dropped. */
export function readConsoleSchedules(config: Record<string, unknown>): ConsoleSchedule[] {
    const raw = config[CONSOLE_SCHEDULES_KEY];
    if (!Array.isArray(raw)) return [];
    return raw
        .flatMap((entry): ConsoleSchedule[] => {
            if (typeof entry !== "object" || entry === null) return [];
            const row = entry as Record<string, unknown>;
            const repeat = readRepeat(row.repeat);
            if (
                typeof row.id !== "string" ||
                typeof row.commandId !== "string" ||
                typeof row.command !== "string" ||
                typeof row.createdBy !== "string" ||
                !repeat
            ) {
                return [];
            }
            const values =
                typeof row.values === "object" && row.values !== null
                    ? Object.fromEntries(
                          Object.entries(row.values as Record<string, unknown>).filter(
                              (pair): pair is [string, string] => typeof pair[1] === "string"
                          )
                      )
                    : {};
            return [
                {
                    id: row.id,
                    commandId: row.commandId,
                    label: typeof row.label === "string" ? row.label : row.command,
                    command: row.command,
                    variables: readCustomVariables(row.variables),
                    values,
                    target: readTarget(row.target),
                    repeat,
                    nextAt:
                        typeof row.nextAt === "string" && !Number.isNaN(Date.parse(row.nextAt))
                            ? row.nextAt
                            : null,
                    done: count(row.done),
                    skipped: count(row.skipped),
                    last: readRun(row.last),
                    createdBy: row.createdBy
                }
            ];
        })
        .slice(0, MAX_CONSOLE_SCHEDULES);
}
