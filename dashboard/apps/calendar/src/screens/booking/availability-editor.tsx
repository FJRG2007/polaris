"use client";

/**
 * When a booking page takes bookings: hours per weekday, and dates that differ
 * from their weekday - other hours, or closed.
 */

import { useState } from "react";
import { GroupHeading } from "../ui";
import { useCalendarT } from "../i18n";
import { Plus, Trash2 } from "lucide-react";
import { hostUi } from "@polaris/app-host/client";
import { Button, Input, Switch } from "@polaris/ui";
import { addDays, formatDay, isDayString } from "../time";
import { SUNDAY, WEEKDAYS, type BookingDraft } from "./model";

type Availability = BookingDraft["availability"];
type Range = { from: string; to: string };

const DEFAULT_RANGE: Range = { from: "09:00", to: "17:00" };

/** One day's ranges, each a pair of time fields with a remove button. */
function Ranges({ ranges, onChange, label }: { ranges: readonly Range[]; onChange: (ranges: Range[]) => void; label: string }) {
    const t = useCalendarT();
    return (
        <div className="flex flex-col gap-1.5">
            {ranges.map((range, index) => (
                <div key={index} className="flex flex-wrap items-center gap-1.5">
                    <Input
                        type="time"
                        value={range.from}
                        onChange={(event) => onChange(ranges.map((entry, at) => (at === index ? { ...entry, from: event.target.value } : entry)))}
                        aria-label={t("bookingPage.fromOf", { day: label })}
                        className="w-28"
                    />
                    <span className="text-foreground-subtle" aria-hidden>
                        -
                    </span>
                    <Input
                        type="time"
                        value={range.to === "24:00" ? "23:59" : range.to}
                        onChange={(event) => onChange(ranges.map((entry, at) => (at === index ? { ...entry, to: event.target.value } : entry)))}
                        aria-label={t("bookingPage.toOf", { day: label })}
                        className="w-28"
                    />
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => onChange(ranges.filter((_, at) => at !== index))}
                        aria-label={t("bookingPage.removeHours")}
                        title={t("bookingPage.removeHours")}
                    >
                        <Trash2 />
                    </Button>
                </div>
            ))}
            <div>
                <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                        const last = ranges[ranges.length - 1];
                        onChange([...ranges, last && last.to < "22:00" ? { from: last.to, to: last.to < "21:00" ? "22:00" : "23:00" } : DEFAULT_RANGE]);
                    }}
                >
                    <Plus />
                    {t("bookingPage.addHours")}
                </Button>
            </div>
        </div>
    );
}

export function AvailabilityEditor({ value, onChange, error }: { value: Availability; onChange: (value: Availability) => void; error: string | null }) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const [date, setDate] = useState("");
    const overrides = Object.entries(value.overrides).sort(([left], [right]) => left.localeCompare(right));

    const setDay = (day: (typeof WEEKDAYS)[number], ranges: Range[]) => onChange({ ...value, weekly: { ...value.weekly, [day]: ranges } });
    const setOverride = (key: string, ranges: Range[] | null) => {
        const next = { ...value.overrides };
        if (ranges === null) delete next[key];
        else next[key] = ranges;
        onChange({ ...value, overrides: next });
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
                <GroupHeading>{t("bookingPage.weeklyHours")}</GroupHeading>
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {WEEKDAYS.map((day) => {
                        const label = formatDay(addDays(SUNDAY, Number(day)), locale, { weekday: "long" });
                        const ranges = value.weekly[day];
                        return (
                            <li key={day} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-start">
                                <div className="flex items-center gap-2 sm:w-40 sm:pt-1">
                                    <Switch
                                        checked={ranges.length > 0}
                                        onChange={(open) => setDay(day, open ? [DEFAULT_RANGE] : [])}
                                        aria-label={t("bookingPage.openOn", { day: label })}
                                    />
                                    <span className="capitalize">{label}</span>
                                </div>
                                {ranges.length > 0 ? (
                                    <Ranges ranges={ranges} onChange={(next) => setDay(day, next)} label={label} />
                                ) : (
                                    <span className="text-foreground-subtle sm:pt-1.5">{t("bookingPage.closed")}</span>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </div>

            <div className="flex flex-col gap-2">
                <GroupHeading>{t("bookingPage.dateOverrides")}</GroupHeading>
                <p className="text-xs text-foreground-subtle">{t("bookingPage.dateOverridesHint")}</p>
                {overrides.length > 0 ? (
                    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                        {overrides.map(([key, ranges]) => {
                            const label = formatDay(key, locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
                            return (
                                <li key={key} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-start">
                                    <div className="flex items-center gap-2 sm:w-40 sm:pt-1">
                                        <Switch
                                            checked={ranges.length > 0}
                                            onChange={(open) => setOverride(key, open ? [DEFAULT_RANGE] : [])}
                                            aria-label={t("bookingPage.openOn", { day: label })}
                                        />
                                        <span>{label}</span>
                                    </div>
                                    <div className="flex flex-1 items-start justify-between gap-2">
                                        {ranges.length > 0 ? (
                                            <Ranges ranges={ranges} onChange={(next) => setOverride(key, next)} label={label} />
                                        ) : (
                                            <span className="text-foreground-subtle sm:pt-1.5">{t("bookingPage.closed")}</span>
                                        )}
                                        <Button
                                            size="icon-sm"
                                            variant="ghost"
                                            onClick={() => setOverride(key, null)}
                                            aria-label={t("bookingPage.removeOverride", { day: label })}
                                            title={t("bookingPage.removeOverride", { day: label })}
                                        >
                                            <Trash2 />
                                        </Button>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                    <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label={t("bookingPage.overrideDate")} className="w-44" />
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={!isDayString(date) || date in value.overrides}
                        onClick={() => {
                            setOverride(date, []);
                            setDate("");
                        }}
                    >
                        <Plus />
                        {t("bookingPage.addOverride")}
                    </Button>
                </div>
            </div>
            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
