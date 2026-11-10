/**
 * A schedule in one sentence ("Every Monday and Friday at 08:00"), and what is
 * wrong with one, in the reader's language.
 *
 * The same words on the canvas card, the list step and the settings panel, so a
 * schedule reads the same wherever it is drawn. Pure apart from `t`, so the
 * tests can read it.
 */

import * as core from "@polaris/core";
import type { T } from "./node-fields";

const DAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"] as const;
const MONTH_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] as const;

/** A weekday's name, 0 = Sunday. */
export function dayName(t: T, day: number): string {
    return t(`schedule.days.${DAY_KEYS[day] ?? "0"}`);
}

/** A month's name, 1 = January. */
export function monthName(t: T, month: number): string {
    return t(`schedule.months.${MONTH_KEYS[month - 1] ?? "1"}`);
}

/** Weekdays in the order a week is drawn, from the day it starts on. */
export function weekOrder(weekStartsOn: number): number[] {
    return Array.from({ length: 7 }, (_, at) => (weekStartsOn + at) % 7);
}

/** "a, b and c", with the language's own "and". */
export function joinWords(t: T, items: readonly string[]): string {
    if (items.length <= 1) return items[0] ?? "";
    return t("schedule.summary.and", {
        head: items.slice(0, -1).join(", "),
        last: items[items.length - 1]!
    });
}

/** "March 5" / "5 de marzo". */
export function monthDayWords(t: T, month: number, day: number): string {
    return t("schedule.monthDate", { month: monthName(t, month), day });
}

function timesWords(t: T, times: readonly string[]): string {
    return joinWords(t, [...new Set(times)].sort());
}

/** The sentence for a schedule, or null when its settings are not complete yet. */
export function scheduleSummary(t: T, value: unknown, weekStartsOn = 1): string | null {
    const parsed = core.scheduleConfigSchema.safeParse(value);
    if (!parsed.success) return null;
    const config = parsed.data;
    switch (config.kind) {
        case "every":
            return t(
                config.unit === "minutes"
                    ? "schedule.summary.everyMinutes"
                    : config.unit === "hours"
                      ? "schedule.summary.everyHours"
                      : "schedule.summary.everyDays",
                { amount: config.amount }
            );
        case "daily": {
            const times = timesWords(t, config.times);
            const days = new Set(config.days);
            if (days.size === 0 || days.size === 7) return t("schedule.summary.daily", { times });
            const names = weekOrder(weekStartsOn)
                .filter((day) => days.has(day))
                .map((day) => dayName(t, day));
            return t("schedule.summary.weekdays", { days: joinWords(t, names), times });
        }
        case "monthly": {
            const times = timesWords(t, config.times);
            const numbers = [...new Set(config.days.filter((day) => day !== "last"))].sort(
                (a, b) => a - b
            );
            const last = config.days.includes("last");
            if (numbers.length === 0) return t("schedule.summary.lastOnly", { times });
            const days = joinWords(t, numbers.map(String));
            return t(last ? "schedule.summary.monthlyLast" : "schedule.summary.monthly", {
                days,
                times
            });
        }
        case "yearly": {
            const seen = new Set<number>();
            const dates = [...config.dates]
                .sort((a, b) => a.month - b.month || a.day - b.day)
                .filter((date) => {
                    const key = date.month * 100 + date.day;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                })
                .map((date) => monthDayWords(t, date.month, date.day));
            return t("schedule.summary.yearly", {
                dates: joinWords(t, dates),
                times: timesWords(t, config.times)
            });
        }
        case "once": {
            const [date, time] = config.at.split("T") as [string, string];
            const [year, month, day] = date.split("-").map(Number) as [number, number, number];
            return t("schedule.summary.once", {
                date: t("schedule.fullDate", {
                    date: monthDayWords(t, month, day),
                    year
                }),
                time
            });
        }
        case "cron":
            return t("schedule.summary.cron", { expression: config.expression });
    }
}

const PROBLEMS = [
    "clockTime",
    "cronInvalid",
    "daysRequired",
    "datesRequired",
    "dateInvalid",
    "dateTimeInvalid"
] as const;
export type ScheduleProblem =
    | (typeof PROBLEMS)[number]
    | "timesRequired"
    | "amountInvalid"
    | "invalid";

/** What is wrong with a schedule, from the schema the server checks it with; null when nothing is. */
export function scheduleProblem(value: unknown): ScheduleProblem | null {
    const parsed = core.scheduleConfigSchema.safeParse(value);
    if (parsed.success) return null;
    const issue = parsed.error.issues[0]!;
    const known = PROBLEMS.find((problem) => problem === issue.message);
    if (known) return known;
    if (issue.path[0] === "times") return "timesRequired";
    if (issue.path[0] === "amount") return "amountInvalid";
    return "invalid";
}
