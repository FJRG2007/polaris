"use client";

/**
 * The schedule trigger's settings: what kind of repeat, in plain words, and
 * then only the controls that kind needs - times as chips, weekdays and days
 * of the month as toggles, dates of the year as pickers. Under them, the
 * schedule in one sentence and the next times it runs, in the automation's
 * own time zone, so a reader sees what they set before they publish it.
 *
 * Every check is the schema the server stores it with (`scheduleProblem`).
 */

import { useMemo } from "react";
import * as core from "@polaris/core";
import { Field } from "./node-fields";
import { Plus, X } from "lucide-react";
import * as words from "./schedule-words";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, DateInput, Input, Select, cn, type SelectOption } from "@polaris/ui";

// A draft is any shape until it parses.
type Config = Record<string, any>;

const KINDS = ["every", "daily", "monthly", "yearly", "once", "cron"] as const;
type Kind = (typeof KINDS)[number];
const MAX_TIMES = 12;
const MAX_DATES = 24;

/** The hour after the last time, or the first free one, so "Add time" never adds a copy. */
function nextFreeTime(times: readonly string[]): string {
    const last = times[times.length - 1] ?? "07:00";
    const [hour, minute] = last.split(":").map(Number) as [number, number];
    for (let step = 1; step <= 24; step += 1) {
        const candidate = `${String(((hour || 0) + step) % 24).padStart(2, "0")}:${String(minute || 0).padStart(2, "0")}`;
        if (!times.includes(candidate)) return candidate;
    }
    return last;
}

/** The date after the last one, so "Add date" never adds a copy. */
function dayAfter(date: { month: number; day: number } | undefined): { month: number; day: number } {
    if (!date) return { month: 1, day: 1 };
    if (date.day < core.daysInMonth(2027, date.month)) return { month: date.month, day: date.day + 1 };
    return { month: (date.month % 12) + 1, day: 1 };
}

/** The settings a kind starts from, keeping the times already chosen. */
function startOf(kind: Kind, config: Config, now: Date): Config {
    const times: string[] =
        Array.isArray(config.times) && config.times.length > 0 ? config.times : ["08:00"];
    switch (kind) {
        case "every":
            return { kind, amount: 15, unit: "minutes" };
        case "daily":
            return { kind, times, days: [] };
        case "monthly":
            return { kind, days: [1], times };
        case "yearly":
            return { kind, dates: [{ month: now.getMonth() + 1, day: now.getDate() }], times };
        case "once": {
            const at = new Date(now.getTime() + 3_600_000);
            const pad = (value: number) => String(value).padStart(2, "0");
            return {
                kind,
                at: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:00`
            };
        }
        case "cron":
            return { kind, expression: "0 8 * * 1-5" };
    }
}

export function ScheduleFields({
    config,
    setConfig,
    timeZone
}: {
    config: Config;
    setConfig: (config: unknown) => void;
    timeZone: string;
}) {
    const t = useTranslations("automations");
    const format = useDisplayFormat();
    const set = (change: Config) => setConfig({ ...config, ...change });
    const kind: Kind = KINDS.includes(config.kind) ? config.kind : "every";
    const problem = words.scheduleProblem(config);
    const summary = words.scheduleSummary(t, config, format.weekStartsOn);
    const key = JSON.stringify(config);
    const zoned = useMemo(
        () => core.createDisplayFormat({ ...format.preferences, timeZone }),
        [format.preferences, timeZone]
    );
    const runs = useMemo(() => {
        const parsed = core.scheduleConfigSchema.safeParse(config);
        return parsed.success
            ? core.upcomingScheduleRuns(parsed.data, new Date(), timeZone, 3)
            : [];
        // Keyed by the config's value, not its identity.
    }, [key, timeZone]);
    const units: SelectOption[] = [
        { value: "minutes", label: t("fields.minutes") },
        { value: "hours", label: t("fields.hours") },
        { value: "days", label: t("fields.days") }
    ];

    return (
        <div className="space-y-3">
            <Field label={t("fields.scheduleKind")}>
                <Select
                    value={kind}
                    onValueChange={(next) => setConfig(startOf(next as Kind, config, new Date()))}
                    options={KINDS.map((each) => ({
                        value: each,
                        label: t(`schedule.kinds.${each}`)
                    }))}
                    aria-label={t("fields.scheduleKind")}
                />
            </Field>
            {kind === "every" ? (
                <div className="grid grid-cols-2 gap-3">
                    <Field label={t("fields.amount")}>
                        <Input
                            type="number"
                            min={1}
                            max={10_000}
                            value={Number.isFinite(config.amount) ? config.amount : ""}
                            onChange={(event) => set({ amount: event.target.valueAsNumber })}
                            aria-invalid={problem === "amountInvalid" || undefined}
                        />
                    </Field>
                    <Field label={t("fields.unit")}>
                        <Select
                            value={config.unit}
                            onValueChange={(unit) => set({ unit })}
                            options={units}
                            aria-label={t("fields.unit")}
                        />
                    </Field>
                </div>
            ) : kind === "cron" ? (
                <Field label={t("fields.expression")}>
                    <Input
                        value={config.expression ?? ""}
                        onChange={(event) => set({ expression: event.target.value })}
                        placeholder="0 8 * * 1-5"
                        aria-invalid={problem === "cronInvalid" || undefined}
                    />
                </Field>
            ) : kind === "once" ? (
                <Field label={t("schedule.onceAt")}>
                    <DateInput
                        mode="datetime"
                        value={config.at ?? ""}
                        onValueChange={(at) => set({ at: at.slice(0, 16) })}
                        aria-label={t("schedule.onceAt")}
                        aria-invalid={problem === "dateTimeInvalid" || undefined}
                    />
                </Field>
            ) : (
                <>
                    {kind === "daily" && (
                        <Weekdays
                            value={Array.isArray(config.days) ? config.days : []}
                            weekStartsOn={format.weekStartsOn}
                            onChange={(days) => set({ days })}
                        />
                    )}
                    {kind === "monthly" && (
                        <MonthDays
                            value={Array.isArray(config.days) ? config.days : []}
                            onChange={(days) => set({ days })}
                        />
                    )}
                    {kind === "yearly" && (
                        <YearDates
                            value={Array.isArray(config.dates) ? config.dates : []}
                            onChange={(dates) => set({ dates })}
                        />
                    )}
                    <Times
                        value={Array.isArray(config.times) ? config.times : []}
                        onChange={(times) => set({ times })}
                    />
                </>
            )}
            {problem && (
                <p className="text-xs text-danger-ink" role="alert">
                    {t(`schedule.errors.${problem}`)}
                </p>
            )}
            {!problem && summary && (
                <div className="space-y-1 rounded-md bg-muted/40 px-3 py-2">
                    <p className="text-sm font-medium break-words">{summary}</p>
                    {kind === "every" ? (
                        <p className="text-xs text-muted-foreground">{t("schedule.fromPublish")}</p>
                    ) : runs.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("schedule.noNext")}</p>
                    ) : (
                        <>
                            <p className="text-xs text-muted-foreground">
                                {t("schedule.nextRuns", { zone: timeZone })}
                            </p>
                            <ul className="space-y-0.5 text-xs tabular-nums">
                                {runs.map((run) => {
                                    const wall = core.wallClock(run, timeZone);
                                    const weekday = new Date(
                                        Date.UTC(wall.year, wall.month - 1, wall.day)
                                    ).getUTCDay();
                                    return (
                                        <li key={run.getTime()}>
                                            {words.dayName(t, weekday)}, {zoned.dateTime(run)}
                                        </li>
                                    );
                                })}
                            </ul>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

/** Clock times as chips, each its own time field, with "Add time". */
function Times({ value, onChange }: { value: string[]; onChange: (times: string[]) => void }) {
    const t = useTranslations("automations");
    return (
        <div className="space-y-1 text-sm">
            <span>{t("schedule.times")}</span>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("schedule.times")}>
                {value.map((time, index) => (
                    <span
                        key={index}
                        className="flex items-center gap-0.5 rounded-md border border-border bg-muted/40 py-0.5 pr-0.5 pl-0.5"
                    >
                        <DateInput
                            mode="time"
                            value={time}
                            onValueChange={(next) =>
                                onChange(value.map((each, at) => (at === index ? next : each)))
                            }
                            aria-label={t("schedule.timeN", { n: index + 1 })}
                            className="w-[6.5rem]"
                        />
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            disabled={value.length <= 1}
                            title={t("schedule.removeTime", { time })}
                            aria-label={t("schedule.removeTime", { time })}
                            onClick={() => onChange(value.filter((_, at) => at !== index))}
                        >
                            <X aria-hidden="true" />
                        </Button>
                    </span>
                ))}
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={value.length >= MAX_TIMES}
                    onClick={() => onChange([...value, nextFreeTime(value)])}
                >
                    <Plus aria-hidden="true" />
                    {t("schedule.addTime")}
                </Button>
            </div>
        </div>
    );
}

function Toggle({
    pressed,
    onClick,
    label,
    title,
    className
}: {
    pressed: boolean;
    onClick: () => void;
    label: string;
    title?: string;
    className?: string;
}) {
    return (
        <Button
            type="button"
            size="sm"
            variant={pressed ? "primary" : "outline"}
            aria-pressed={pressed}
            title={title}
            onClick={onClick}
            className={cn("min-w-0 px-0", className)}
        >
            <span className="truncate">{label}</span>
        </Button>
    );
}

/** Weekday toggles from the reader's first day of the week; none pressed is every day. */
function Weekdays({
    value,
    weekStartsOn,
    onChange
}: {
    value: number[];
    weekStartsOn: number;
    onChange: (days: number[]) => void;
}) {
    const t = useTranslations("automations");
    const chosen = new Set(value);
    const flip = (day: number) =>
        onChange(
            chosen.has(day)
                ? value.filter((each) => each !== day)
                : [...value, day].sort((a, b) => a - b)
        );
    return (
        <div className="space-y-1 text-sm">
            <span>{t("fields.weekdays")}</span>
            <div className="grid grid-cols-7 gap-1" role="group" aria-label={t("fields.weekdays")}>
                {words.weekOrder(weekStartsOn).map((day) => (
                    <Toggle
                        key={day}
                        pressed={chosen.has(day)}
                        onClick={() => flip(day)}
                        label={t(`weekdays.${String(day) as "0"}`)}
                        title={words.dayName(t, day)}
                    />
                ))}
            </div>
            <div className="flex flex-wrap gap-1">
                <Button type="button" variant="ghost" size="xs" onClick={() => onChange([])}>
                    {t("fields.everyDay")}
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => onChange([1, 2, 3, 4, 5])}
                >
                    {t("schedule.workweek")}
                </Button>
                <Button type="button" variant="ghost" size="xs" onClick={() => onChange([0, 6])}>
                    {t("schedule.weekend")}
                </Button>
            </div>
        </div>
    );
}

/** Days 1-31 and the month's last day, as toggles. */
function MonthDays({
    value,
    onChange
}: {
    value: (number | "last")[];
    onChange: (days: (number | "last")[]) => void;
}) {
    const t = useTranslations("automations");
    const chosen = new Set(value);
    const flip = (day: number | "last") => {
        const next = chosen.has(day) ? value.filter((each) => each !== day) : [...value, day];
        const numbers = next.filter((each): each is number => each !== "last").sort((a, b) => a - b);
        onChange(next.includes("last") ? [...numbers, "last"] : numbers);
    };
    const high = value.some((day) => typeof day === "number" && day > 28);
    return (
        <div className="space-y-1 text-sm">
            <span>{t("schedule.monthDays")}</span>
            <div className="grid grid-cols-7 gap-1" role="group" aria-label={t("schedule.monthDays")}>
                {Array.from({ length: 31 }, (_, at) => at + 1).map((day) => (
                    <Toggle
                        key={day}
                        pressed={chosen.has(day)}
                        onClick={() => flip(day)}
                        label={String(day)}
                    />
                ))}
                <Toggle
                    pressed={chosen.has("last")}
                    onClick={() => flip("last")}
                    label={t("schedule.lastDay")}
                    className="col-span-4 px-2"
                />
            </div>
            {high && <p className="text-xs text-muted-foreground">{t("schedule.shortMonths")}</p>}
        </div>
    );
}

/** Dates of the year, each a month and a day. */
function YearDates({
    value,
    onChange
}: {
    value: { month: number; day: number }[];
    onChange: (dates: { month: number; day: number }[]) => void;
}) {
    const t = useTranslations("automations");
    const months: SelectOption[] = Array.from({ length: 12 }, (_, at) => ({
        value: String(at + 1),
        label: words.monthName(t, at + 1)
    }));
    const put = (index: number, date: { month: number; day: number }) =>
        onChange(value.map((each, at) => (at === index ? date : each)));
    const leap = value.some((date) => date.month === 2 && date.day === 29);
    return (
        <div className="space-y-1 text-sm">
            <span>{t("schedule.dates")}</span>
            <ul className="space-y-1.5">
                {value.map((date, index) => {
                    // A leap year's month lengths, so February 29 can be picked.
                    const length = core.daysInMonth(2028, date.month);
                    return (
                        <li key={index} className="flex min-w-0 items-center gap-1.5">
                            <Select
                                value={String(date.month)}
                                onValueChange={(month) =>
                                    put(index, {
                                        month: Number(month),
                                        day: Math.min(date.day, core.daysInMonth(2028, Number(month)))
                                    })
                                }
                                options={months}
                                aria-label={t("schedule.month")}
                                className="min-w-0 flex-1"
                            />
                            <Select
                                value={String(date.day)}
                                onValueChange={(day) => put(index, { ...date, day: Number(day) })}
                                options={Array.from({ length }, (_, at) => ({
                                    value: String(at + 1),
                                    label: String(at + 1)
                                }))}
                                aria-label={t("schedule.day")}
                                className="w-20 shrink-0"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                disabled={value.length <= 1}
                                title={t("schedule.removeDate")}
                                aria-label={t("schedule.removeDate")}
                                onClick={() => onChange(value.filter((_, at) => at !== index))}
                            >
                                <X aria-hidden="true" />
                            </Button>
                        </li>
                    );
                })}
            </ul>
            <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={value.length >= MAX_DATES}
                onClick={() => onChange([...value, dayAfter(value[value.length - 1])])}
            >
                <Plus aria-hidden="true" />
                {t("schedule.addDate")}
            </Button>
            {leap && <p className="text-xs text-muted-foreground">{t("schedule.leapDay")}</p>}
        </div>
    );
}
