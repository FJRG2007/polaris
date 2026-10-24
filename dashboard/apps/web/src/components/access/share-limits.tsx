"use client";

/**
 * The "only sometimes" half of a share: days, hours, a stay, a number of uses
 * and a fence. One editor for a share being made and for a row of "People with
 * access" being changed, so both say the same thing in the same words.
 */

import * as core from "@polaris/core";
import type { ReactNode } from "react";
import { Input, Switch } from "@polaris/ui";
import type { GrantView } from "@/lib/access/grants";
import { CalendarClock, MapPin } from "lucide-react";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { WeekdayPicker } from "@/components/weekday-picker";
import { useTranslations } from "@/components/i18n/i18n-provider";

export interface LimitsValue {
    limited: boolean;
    startsAt: string;
    endsAt: string;
    checkIn: string;
    checkOut: string;
    days: number;
    hours: { from: string; to: string };
    maxUses: string;
    nearby: boolean;
    nearbyMeters: string;
}

export const EMPTY_LIMITS: LimitsValue = {
    limited: false,
    startsAt: "",
    endsAt: "",
    checkIn: "",
    checkOut: "",
    days: core.EVERY_DAY,
    hours: { from: "", to: "" },
    maxUses: "",
    nearby: false,
    nearbyMeters: "100"
};

/** Where a fence means anything: an act that happens at a place. */
export function isFenceable(subject: core.GrantSubject): boolean {
    return (
        subject === "place.device" ||
        subject === "place.ups" ||
        subject === "place.room" ||
        subject === "place.panel"
    );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The day and the time of an ISO moment, in the reader's own zone. */
function split(iso: string | null): { day: string; clock: string } {
    if (!iso) return { day: "", clock: "" };
    const at = new Date(iso);
    const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    return {
        day: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
        clock: clock === "00:00" || clock === "23:59" ? "" : clock
    };
}

/** A row's bounds, back in the editor's shape. */
export function limitsOf(grant: GrantView): LimitsValue {
    const schedule = grant.schedule;
    const from = split(schedule.startsAt);
    const to = split(schedule.endsAt);
    return {
        limited:
            schedule.startsAt !== null ||
            schedule.endsAt !== null ||
            schedule.days !== core.EVERY_DAY ||
            schedule.startMinute !== null ||
            schedule.maxUses !== null,
        startsAt: from.day,
        endsAt: to.day,
        checkIn: from.clock,
        checkOut: to.clock,
        days: schedule.days,
        hours: {
            from: schedule.startMinute === null ? "" : core.clockTime(schedule.startMinute),
            to: schedule.endMinute === null ? "" : core.clockTime(schedule.endMinute)
        },
        maxUses: schedule.maxUses === null ? "" : String(schedule.maxUses),
        nearby: schedule.nearbyMeters !== null,
        nearbyMeters: String(schedule.nearbyMeters ?? 100)
    };
}

/** Whether the fence is outside what a grant may draw. */
export function badFence(subject: core.GrantSubject, value: LimitsValue): boolean {
    if (!isFenceable(subject) || !value.nearby) return false;
    const metres = Number(value.nearbyMeters);
    return !Number.isInteger(metres) || metres < core.NEARBY_MIN_M || metres > core.NEARBY_MAX_M;
}

/** The editor's value as the bounds a grant is written with. */
export function boundsOf(subject: core.GrantSubject, value: LimitsValue) {
    return {
        nearbyMeters: isFenceable(subject) && value.nearby ? Number(value.nearbyMeters) : null,
        ...(value.limited
            ? {
                  // The picked day, in the reader's own zone, and the last one
                  // lent whole: sent as a bare date these are both midnight
                  // UTC, which begins a grant early and ends it a day short.
                  startsAt: (value.checkIn
                      ? core.dayAt(value.startsAt, value.checkIn)
                      : core.dayBegins(value.startsAt)
                  )?.toISOString(),
                  endsAt: (value.checkOut
                      ? core.dayAt(value.endsAt, value.checkOut)
                      : core.dayEnds(value.endsAt)
                  )?.toISOString(),
                  days: value.days,
                  startMinute: core.clockMinute(value.hours.from),
                  endMinute: core.clockMinute(value.hours.to),
                  maxUses: value.maxUses ? Number(value.maxUses) : null
              }
            : {})
    };
}

export function LimitsFields({
    subject,
    bounded,
    value,
    onChange,
    located,
    idPrefix
}: {
    subject: core.GrantSubject;
    /** Whether hours, dates and uses mean anything here. */
    bounded: boolean;
    value: LimitsValue;
    onChange: (next: LimitsValue) => void;
    /** Whether the place has a location, for the fence's warning. */
    located: boolean | null;
    idPrefix: string;
}) {
    const t = useTranslations("components");
    const set = (patch: Partial<LimitsValue>) => onChange({ ...value, ...patch });
    const id = (name: string) => `${idPrefix}-${name}`;
    const fenceable = isFenceable(subject);
    const wrongFence = badFence(subject, value);

    return (
        <div className="flex min-w-0 flex-col gap-3">
            {bounded ? (
                <div className="flex flex-col gap-3">
                    <label className="flex items-center justify-between gap-2 text-[13px] text-foreground">
                        <span className="flex min-w-0 items-center gap-2">
                            <CalendarClock
                                className="size-4 shrink-0 text-foreground-subtle"
                                aria-hidden
                            />
                            {t("share.sometimes")}
                        </span>
                        <Switch
                            checked={value.limited}
                            onChange={(limited) => set({ limited })}
                            aria-label={t("share.limit")}
                        />
                    </label>
                    {value.limited ? (
                        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                            <div className="grid gap-3 sm:grid-cols-2">
                                <Field label={t("share.fromDay")} htmlFor={id("from-day")}>
                                    <Input
                                        id={id("from-day")}
                                        type="date"
                                        value={value.startsAt}
                                        onChange={(event) => set({ startsAt: event.target.value })}
                                    />
                                </Field>
                                <Field label={t("share.toDay")} htmlFor={id("to-day")}>
                                    <Input
                                        id={id("to-day")}
                                        type="date"
                                        value={value.endsAt}
                                        onChange={(event) => set({ endsAt: event.target.value })}
                                    />
                                </Field>
                                <Field label={t("share.checkIn")} htmlFor={id("check-in")}>
                                    <Input
                                        id={id("check-in")}
                                        type="time"
                                        value={value.checkIn}
                                        disabled={!value.startsAt}
                                        onChange={(event) => set({ checkIn: event.target.value })}
                                    />
                                </Field>
                                <Field label={t("share.checkOut")} htmlFor={id("check-out")}>
                                    <Input
                                        id={id("check-out")}
                                        type="time"
                                        value={value.checkOut}
                                        disabled={!value.endsAt}
                                        onChange={(event) => set({ checkOut: event.target.value })}
                                    />
                                </Field>
                            </div>
                            <WeekdayPicker
                                legend={t("share.days")}
                                days={value.days}
                                onChange={(days) => set({ days })}
                            />
                            <div className="grid gap-3 sm:grid-cols-2">
                                <Field label={t("share.fromHour")} htmlFor={id("from-hour")}>
                                    <Input
                                        id={id("from-hour")}
                                        type="time"
                                        value={value.hours.from}
                                        onChange={(event) =>
                                            set({
                                                hours: { ...value.hours, from: event.target.value }
                                            })
                                        }
                                    />
                                </Field>
                                <Field label={t("share.toHour")} htmlFor={id("to-hour")}>
                                    <Input
                                        id={id("to-hour")}
                                        type="time"
                                        value={value.hours.to}
                                        onChange={(event) =>
                                            set({
                                                hours: { ...value.hours, to: event.target.value }
                                            })
                                        }
                                    />
                                </Field>
                            </div>
                            <Field label={t("share.uses")} htmlFor={id("uses")}>
                                <Input
                                    id={id("uses")}
                                    type="number"
                                    min={1}
                                    inputMode="numeric"
                                    placeholder={t("share.usesPlaceholder")}
                                    value={value.maxUses}
                                    onChange={(event) => set({ maxUses: event.target.value })}
                                />
                            </Field>
                            <p className="text-[12px] text-foreground-subtle">
                                {t("share.usesHint")}
                            </p>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {fenceable ? (
                <div className="flex flex-col gap-2">
                    <label className="flex items-center justify-between gap-2 text-[13px] text-foreground">
                        <span className="flex min-w-0 items-center gap-2">
                            <MapPin
                                className="size-4 shrink-0 text-foreground-subtle"
                                aria-hidden
                            />
                            {t("share.nearbyLabel")}
                        </span>
                        <Switch
                            checked={value.nearby}
                            onChange={(nearby) => set({ nearby })}
                            aria-label={t("share.nearbyLabel")}
                        />
                    </label>
                    {value.nearby ? (
                        <>
                            <Field label={t("share.nearbyMeters")} htmlFor={id("nearby")}>
                                <Input
                                    id={id("nearby")}
                                    type="number"
                                    min={core.NEARBY_MIN_M}
                                    max={core.NEARBY_MAX_M}
                                    step={25}
                                    inputMode="numeric"
                                    value={value.nearbyMeters}
                                    aria-invalid={wrongFence || undefined}
                                    onChange={(event) => set({ nearbyMeters: event.target.value })}
                                />
                            </Field>
                            <p className="text-[12px] text-foreground-subtle">
                                {t("share.nearbyHint")}
                            </p>
                            {located === false ? (
                                <p role="alert" className="text-[12px] text-danger-ink">
                                    {t("share.nearbyNoPlace")}
                                </p>
                            ) : null}
                        </>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

export function Field({
    label,
    htmlFor,
    children
}: {
    label: string;
    htmlFor: string;
    children: ReactNode;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <label className="text-[12px] text-muted-foreground" htmlFor={htmlFor}>
                {label}
            </label>
            {children}
        </div>
    );
}

/** The bounds of one grant in a line, or "" when it has none. */
export function describeGrant(
    grant: GrantView,
    weekOrder: readonly number[],
    t: NamespaceTranslator<"components">,
    dayNames: readonly string[]
): string {
    const schedule = grant.schedule;
    // The day, and the time too when the bound is a check-in or a check-out
    // rather than the whole day.
    const day = (iso: string) => {
        const { day: date, clock } = split(iso);
        return clock ? `${date} ${clock}` : date;
    };
    const parts: string[] = [];
    if (schedule.startsAt && schedule.endsAt) {
        parts.push(t("share.range", { from: day(schedule.startsAt), to: day(schedule.endsAt) }));
    } else if (schedule.startsAt) {
        parts.push(t("share.fromOnly", { from: day(schedule.startsAt) }));
    } else if (schedule.endsAt) {
        parts.push(t("share.untilOnly", { to: day(schedule.endsAt) }));
    }
    const mask = schedule.days & core.EVERY_DAY;
    if (mask !== core.EVERY_DAY) {
        parts.push(
            mask === core.WEEKDAYS
                ? t("share.weekdays")
                : mask === core.WEEKEND
                  ? t("share.weekends")
                  : mask === 0
                    ? t("share.noDays")
                    : weekOrder
                          .filter((one) => core.runsOnDay(mask, one))
                          .map((one) => dayNames[one])
                          .join(", ")
        );
    }
    if (schedule.startMinute !== null && schedule.endMinute !== null) {
        parts.push(
            t("share.range", {
                from: core.clockTime(schedule.startMinute),
                to: core.clockTime(schedule.endMinute)
            })
        );
    }
    if (schedule.maxUses !== null) {
        parts.push(t("share.usesOf", { uses: schedule.uses, max: schedule.maxUses }));
    }
    return parts.join(" - ");
}
