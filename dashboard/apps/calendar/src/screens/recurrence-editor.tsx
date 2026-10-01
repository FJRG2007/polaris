"use client";

/**
 * The repeat editor, Nextcloud's: every N days, weeks on chosen weekdays,
 * months on chosen days or "on the [first..fifth, second-to-last, last]
 * [weekday / day / weekday / weekend day]", years in chosen months; ending
 * never, on a date, or after a number of times. The sentence under it is the
 * engine's summary of exactly the rule that will be saved.
 *
 * A rule the editor cannot show faithfully is drawn as its summary, read-only,
 * until the person chooses to replace it.
 */

import { ToggleChip } from "./ui";
import * as engine from "../engine";
import { useCalendarT, useRuleT } from "./i18n";
import { useId, useMemo, useState } from "react";
import { Button, Input, Select } from "@polaris/ui";
import { AlertTriangle, Repeat } from "lucide-react";

type Model = engine.RuleEditorModel;

const ORDINALS: readonly engine.RuleOrdinal[] = [1, 2, 3, 4, 5, -2, -1];
const ORDINAL_KEY: Record<string, "n1" | "n2" | "n3" | "n4" | "n5" | "secondLast" | "last"> = { "1": "n1", "2": "n2", "3": "n3", "4": "n4", "5": "n5", "-2": "secondLast", "-1": "last" };

function weekdayName(day: engine.Weekday, locale: string, width: "long" | "short"): string {
    // 2024-01-01 was a Monday.
    const date = new Date(Date.UTC(2024, 0, 1 + engine.WEEKDAYS.indexOf(day)));
    return new Intl.DateTimeFormat(locale, { weekday: width, timeZone: "UTC" }).format(date);
}

function monthName(month: number, locale: string): string {
    return new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, month - 1, 1)));
}

function toggled<T>(list: readonly T[], item: T): T[] {
    return list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];
}

export function RecurrenceEditor({
    value,
    onChange,
    start,
    rule,
    disabled,
    lockedReason,
    onReplace
}: {
    value: Model;
    onChange: (model: Model) => void;
    /** The event's start: what the summary and the defaults are read from. */
    start: engine.DateValue | null;
    /** The rule as it was loaded, to tell whether it can be shown. */
    rule: engine.RecurrenceRule | null;
    disabled?: boolean;
    /** Why repeating cannot be changed here (an exception of a series). */
    lockedReason?: string | null;
    /** The person chose to replace a rule the editor cannot show. */
    onReplace?: () => void;
}) {
    const t = useCalendarT();
    const { words, locale } = useRuleT();
    const ids = useId();
    const [replacing, setReplacing] = useState(false);
    const unsupported = rule !== null && !rule.supported && !replacing;

    const summary = useMemo(() => {
        if (value.frequency === "NONE" || !start) return null;
        try {
            const built = engine.ruleFromEditor(value, start);
            return built ? engine.summarizeRule(built, words, locale) : null;
        } catch {
            return null;
        }
    }, [value, start, words, locale]);

    if (lockedReason) {
        return (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Repeat aria-hidden className="size-4 text-foreground-subtle" />
                {lockedReason}
            </p>
        );
    }

    if (unsupported && rule) {
        return (
            <div className="flex flex-col gap-2 rounded-md border border-warning-edge bg-warning-soft p-3 text-warning-ink">
                <p className="flex items-start gap-2 text-xs">
                    <AlertTriangle aria-hidden className="mt-0.5 size-4" />
                    <span>{t("repeat.unsupported")}</span>
                </p>
                <p className="text-[0.8125rem] font-medium">{engine.summarizeRule(rule, words, locale)}</p>
                {!disabled ? (
                    <Button size="sm" variant="outline" className="self-start" onClick={() => {
                            setReplacing(true);
                            onReplace?.();
                        }}>
                        {t("repeat.replace")}
                    </Button>
                ) : null}
            </div>
        );
    }

    const set = (change: Partial<Model>) => onChange({ ...value, ...change });
    const frequencyOptions = (["NONE", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const).map((frequency) => ({ value: frequency, label: t(`repeat.frequency.${frequency}`) }));
    const unit = value.frequency === "NONE" ? null : (`repeat.unit.${value.frequency}` as const);
    const ordinalControls = (
        <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("repeat.onThe")}</span>
            <Select
                className="w-40"
                aria-label={t("repeat.ordinal")}
                disabled={disabled}
                value={String(value.ordinal)}
                onValueChange={(next) => set({ ordinal: Number(next) as engine.RuleOrdinal, monthlyMode: "ordinal" })}
                options={ORDINALS.map((ordinal) => ({ value: String(ordinal), label: words(`ordinal.${ORDINAL_KEY[String(ordinal)]}`) }))}
            />
            <Select
                className="w-44"
                aria-label={t("repeat.ordinalDay")}
                disabled={disabled}
                value={value.ordinalDay}
                onValueChange={(next) => set({ ordinalDay: next as Model["ordinalDay"], monthlyMode: "ordinal" })}
                options={[
                    ...engine.WEEKDAYS.map((day) => ({ value: day, label: weekdayName(day, locale, "long") })),
                    { value: "day", label: words("dayKind.day") },
                    { value: "weekday", label: words("dayKind.weekday") },
                    { value: "weekend", label: words("dayKind.weekend") }
                ]}
            />
        </div>
    );

    return (
        <div className="flex flex-col gap-3" aria-label={t("repeat.label")} role="group">
            <div className="flex flex-wrap items-center gap-2">
                <Select className="w-44" aria-label={t("repeat.label")} disabled={disabled} value={value.frequency} onValueChange={(next) => set({ frequency: next as Model["frequency"] })} options={frequencyOptions} />
                {unit ? (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        {t("repeat.every")}
                        <Input
                            type="number"
                            min={1}
                            max={999}
                            inputMode="numeric"
                            className="w-16 tabular-nums"
                            disabled={disabled}
                            value={Number.isFinite(value.interval) ? value.interval : ""}
                            onChange={(event) => set({ interval: Math.max(1, Math.min(999, Math.floor(Number(event.target.value) || 1))) })}
                        />
                        {t(unit, { count: value.interval })}
                    </label>
                ) : null}
            </div>

            {value.frequency === "WEEKLY" ? (
                <div role="group" aria-label={t("repeat.weekdays")} className="flex flex-wrap gap-1">
                    {engine.WEEKDAYS.map((day) => (
                        <ToggleChip key={day} label={weekdayName(day, locale, "long")} pressed={value.weekdays.includes(day)} disabled={disabled} onPressedChange={() => set({ weekdays: toggled(value.weekdays, day) })}>
                            {weekdayName(day, locale, "short")}
                        </ToggleChip>
                    ))}
                </div>
            ) : null}

            {value.frequency === "MONTHLY" ? (
                <div className="flex flex-col gap-2">
                    <div role="radiogroup" aria-label={t("repeat.monthlyMode")} className="flex flex-wrap gap-3 text-xs">
                        {(["day", "ordinal"] as const).map((mode) => (
                            <label key={mode} className="flex items-center gap-1.5">
                                <input type="radio" name={`${ids}-mode`} checked={value.monthlyMode === mode} disabled={disabled} onChange={() => set({ monthlyMode: mode })} className="accent-[hsl(var(--primary))]" />
                                {t(`repeat.mode.${mode}`)}
                            </label>
                        ))}
                    </div>
                    {value.monthlyMode === "day" ? (
                        <div role="group" aria-label={t("repeat.monthDays")} className="grid max-w-xs grid-cols-7 gap-1">
                            {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                                <ToggleChip key={day} pressed={value.monthDays.includes(day)} disabled={disabled} onPressedChange={() => set({ monthDays: toggled(value.monthDays, day) })}>
                                    {day}
                                </ToggleChip>
                            ))}
                        </div>
                    ) : (
                        ordinalControls
                    )}
                </div>
            ) : null}

            {value.frequency === "YEARLY" ? (
                <div className="flex flex-col gap-2">
                    <div role="group" aria-label={t("repeat.months")} className="grid max-w-sm grid-cols-4 gap-1 sm:grid-cols-6">
                        {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                            <ToggleChip key={month} pressed={value.months.includes(month)} disabled={disabled} onPressedChange={() => set({ months: toggled(value.months, month) })}>
                                {monthName(month, locale)}
                            </ToggleChip>
                        ))}
                    </div>
                    <label className="flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={value.monthlyMode === "ordinal"} disabled={disabled} onChange={(event) => set({ monthlyMode: event.target.checked ? "ordinal" : "day" })} className="accent-[hsl(var(--primary))]" />
                        {t("repeat.yearlyOrdinal")}
                    </label>
                    {value.monthlyMode === "ordinal" ? ordinalControls : null}
                </div>
            ) : null}

            {value.frequency !== "NONE" ? (
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        className="w-40"
                        aria-label={t("repeat.ends")}
                        disabled={disabled}
                        value={value.end.kind}
                        onValueChange={(kind) =>
                            set({
                                end:
                                    kind === "until"
                                        ? { kind: "until", date: start ? engine.addDays("date" in start ? start.date : start.dateTime.slice(0, 10), 30) : "" }
                                        : kind === "count"
                                          ? { kind: "count", count: 10 }
                                          : { kind: "never" }
                            })
                        }
                        options={(["never", "until", "count"] as const).map((kind) => ({ value: kind, label: t(`repeat.end.${kind}`) }))}
                    />
                    {value.end.kind === "until" ? (
                        <Input type="date" aria-label={t("repeat.untilDate")} className="w-40 tabular-nums" disabled={disabled} value={value.end.date} onChange={(event) => set({ end: { kind: "until", date: event.target.value } })} />
                    ) : null}
                    {value.end.kind === "count" ? (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Input
                                type="number"
                                min={1}
                                max={1000}
                                inputMode="numeric"
                                aria-label={t("repeat.count")}
                                className="w-20 tabular-nums"
                                disabled={disabled}
                                value={value.end.count}
                                onChange={(event) => set({ end: { kind: "count", count: Math.max(1, Math.min(1000, Math.floor(Number(event.target.value) || 1))) } })}
                            />
                            {t("repeat.times", { count: value.end.kind === "count" ? value.end.count : 0 })}
                        </label>
                    ) : null}
                </div>
            ) : null}

            {summary ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
                    <Repeat aria-hidden className="size-4 text-foreground-subtle" />
                    {summary}
                </p>
            ) : null}
        </div>
    );
}
