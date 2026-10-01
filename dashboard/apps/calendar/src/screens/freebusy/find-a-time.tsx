"use client";

/**
 * Find a time: everybody on an event, one row each, across one day - when each
 * is taken, when each is away from work - and the times everybody is free and
 * at work over the week ahead. Busy blocks only: the grid never learns what
 * anybody is doing, only that they are.
 *
 * Plugs into the event editor as `calendarSlots.FindATime`.
 */

import { useCalendarT } from "../i18n";
import { useMemo, useState } from "react";
import { hostUi } from "@polaris/app-host/client";
import type { FindATimeSlotProps } from "../slots";
import { formatRange, StatusNote } from "../public/kit";
import * as freeBusyActions from "../../actions/freebusy";
import { cacheKey, unwrap, useCachedRead } from "../cached-read";
import { ChevronLeft, ChevronRight, CircleSlash } from "lucide-react";
import { addDays, dayStart, formatDay, todayIn, wallOf } from "../time";
import type { FreeBusyPerson, FreeBusyView } from "../../lib/scheduling-wire";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Skeleton
} from "@polaris/ui";

/** Days of suggestions asked for at once, from the day on screen. */
const SUGGEST_DAYS = 7;

/** Hours labelled along the top of the grid. */
const HOUR_MARKS = [0, 3, 6, 9, 12, 15, 18, 21];

function percent(instant: number, from: number, span: number): number {
    return Math.min(100, Math.max(0, ((instant - from) / span) * 100));
}

function Row({
    person,
    label,
    from,
    to,
    event,
    t
}: {
    person: FreeBusyPerson;
    label: string;
    from: number;
    to: number;
    event: { start: number; end: number };
    t: ReturnType<typeof useCalendarT>;
}) {
    const span = to - from;
    const inside = <T extends { start: string; end: string }>(list: readonly T[]) =>
        list.filter((entry) => Date.parse(entry.end) > from && Date.parse(entry.start) < to);
    return (
        <div className="flex items-center gap-2">
            <div className="w-32 shrink-0 truncate text-[13px] sm:w-44" title={label}>
                {label}
            </div>
            <div className="relative h-7 min-w-0 flex-1 overflow-hidden rounded border border-border bg-field">
                {person.status === "unavailable" ? (
                    <span className="absolute inset-0 flex items-center gap-1 px-2 text-xs text-foreground-subtle">
                        <CircleSlash className="size-3.5" />
                        {t("freeBusy.noInformation")}
                    </span>
                ) : (
                    <>
                        {inside(person.away).map((interval, index) => (
                            <span
                                key={`away-${index}`}
                                aria-hidden
                                className="absolute inset-y-0 bg-muted/70"
                                style={{
                                    left: `${percent(Date.parse(interval.start), from, span)}%`,
                                    right: `${100 - percent(Date.parse(interval.end), from, span)}%`
                                }}
                            />
                        ))}
                        {inside(person.busy).map((interval, index) => (
                            <span
                                key={`busy-${index}`}
                                title={t(
                                    interval.type === "BUSY-TENTATIVE"
                                        ? "freeBusy.tentative"
                                        : interval.type === "BUSY-UNAVAILABLE"
                                          ? "freeBusy.away"
                                          : "freeBusy.busy"
                                )}
                                className={cn(
                                    "absolute inset-y-1 rounded-sm",
                                    interval.type === "BUSY-TENTATIVE"
                                        ? "border border-primary/60 bg-primary/25"
                                        : interval.type === "BUSY-UNAVAILABLE"
                                          ? "bg-warning"
                                          : "bg-primary/70"
                                )}
                                style={{
                                    left: `${percent(Date.parse(interval.start), from, span)}%`,
                                    right: `${100 - percent(Date.parse(interval.end), from, span)}%`
                                }}
                            />
                        ))}
                    </>
                )}
                {event.end > from && event.start < to ? (
                    <span
                        aria-hidden
                        className="pointer-events-none absolute inset-y-0 border-x-2 border-foreground/70"
                        style={{
                            left: `${percent(event.start, from, span)}%`,
                            right: `${100 - percent(event.end, from, span)}%`
                        }}
                    />
                ) : null}
            </div>
        </div>
    );
}

export function FindATime({
    open,
    onOpenChange,
    attendees,
    start,
    end,
    zone,
    onPick
}: FindATimeSlotProps) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const eventStart = Date.parse(start);
    const eventEnd = Date.parse(end);
    const minutes = Math.max(5, Math.round((eventEnd - eventStart) / 60_000) || 30);
    const [day, setDay] = useState(() => wallOf(new Date(eventStart), zone).slice(0, 10));
    const [picked, setPicked] = useState<{ start: string; end: string } | null>(null);
    const people = useMemo(
        () => [...new Set(attendees.map((email) => email.trim().toLowerCase()).filter(Boolean))],
        [attendees]
    );

    const from = dayStart(day, zone);
    const to = dayStart(addDays(day, SUGGEST_DAYS), zone);
    const dayEnd = dayStart(addDays(day, 1), zone).getTime();
    const read = useCachedRead<FreeBusyView>(
        open && people.length > 0
            ? cacheKey("freebusy", people.join(","), day, zone, String(minutes))
            : null,
        async () =>
            (
                await unwrap(
                    () =>
                        freeBusyActions.freeBusyAction({
                            emails: people,
                            userIds: [],
                            from: from.toISOString(),
                            to: to.toISOString(),
                            zone,
                            durationMinutes: minutes
                        }),
                    t("freeBusy.failed")
                )
            ).view
    );

    const today = todayIn(zone, new Date());
    const labelOf = (person: FreeBusyPerson) => person.name || person.key;
    const choose = (slot: { start: string; end: string }) => setPicked(slot);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{t("freeBusy.title")}</DialogTitle>
                    <DialogDescription>{t("freeBusy.description")}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("freeBusy.previousDay")}
                        title={t("freeBusy.previousDay")}
                        onClick={() => setDay(addDays(day, -1))}
                        disabled={day <= today}
                    >
                        <ChevronLeft />
                    </Button>
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("freeBusy.nextDay")}
                        title={t("freeBusy.nextDay")}
                        onClick={() => setDay(addDays(day, 1))}
                    >
                        <ChevronRight />
                    </Button>
                    <span className="text-[13px] font-medium">
                        {formatDay(day, locale, { weekday: "long", day: "numeric", month: "long" })}
                    </span>
                    <span className="ml-auto flex items-center gap-3 text-xs text-foreground-subtle">
                        <span className="flex items-center gap-1">
                            <span
                                aria-hidden
                                className="inline-block size-2.5 rounded-sm bg-primary/70"
                            />
                            {t("freeBusy.busy")}
                        </span>
                        <span className="flex items-center gap-1">
                            <span
                                aria-hidden
                                className="inline-block size-2.5 rounded-sm bg-muted"
                            />
                            {t("freeBusy.away")}
                        </span>
                    </span>
                </div>

                <div className="overflow-x-auto">
                    <div className="flex min-w-[36rem] flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                            <div className="w-32 shrink-0 sm:w-44" />
                            <div className="relative h-4 flex-1 text-[11px] text-foreground-subtle">
                                {HOUR_MARKS.map((hour) => (
                                    <span
                                        key={hour}
                                        className="absolute -translate-x-1/2 tabular-nums first:translate-x-0"
                                        style={{ left: `${(hour / 24) * 100}%` }}
                                    >
                                        {String(hour).padStart(2, "0")}
                                    </span>
                                ))}
                            </div>
                        </div>
                        {read.data
                            ? read.data.people.map((person) => (
                                  <Row
                                      key={person.key}
                                      person={person}
                                      label={labelOf(person)}
                                      from={from.getTime()}
                                      to={dayEnd}
                                      event={{ start: eventStart, end: eventEnd }}
                                      t={t}
                                  />
                              ))
                            : people.map((email) => (
                                  <div key={email} className="flex items-center gap-2">
                                      <div
                                          className="w-32 shrink-0 truncate text-[13px] sm:w-44"
                                          title={email}
                                      >
                                          {email}
                                      </div>
                                      <Skeleton className="h-7 flex-1" />
                                  </div>
                              ))}
                    </div>
                </div>

                {read.error ? <StatusNote tone="danger">{read.error}</StatusNote> : null}
                {people.length === 0 ? (
                    <StatusNote tone="neutral">{t("freeBusy.nobody")}</StatusNote>
                ) : null}

                <div className="flex flex-col gap-2">
                    <h3 className="text-[11px] font-medium uppercase tracking-wider text-foreground-subtle">
                        {t("freeBusy.suggestions")}
                    </h3>
                    {read.data ? (
                        read.data.suggestions.length === 0 ? (
                            <p className="text-[13px] text-muted-foreground">
                                {t("freeBusy.noSuggestions")}
                            </p>
                        ) : (
                            <div className="flex flex-wrap gap-1.5">
                                {read.data.suggestions.map((slot) => (
                                    <Button
                                        key={slot.start}
                                        size="sm"
                                        variant={
                                            picked?.start === slot.start ? "primary" : "outline"
                                        }
                                        aria-pressed={picked?.start === slot.start}
                                        onClick={() => choose(slot)}
                                    >
                                        {formatRange(slot.start, slot.end, zone, locale)}
                                    </Button>
                                ))}
                            </div>
                        )
                    ) : (
                        <div className="flex flex-wrap gap-1.5">
                            {[0, 1, 2, 3].map((index) => (
                                <Skeleton key={index} className="h-7 w-48" />
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        {t("freeBusy.cancel")}
                    </Button>
                    <Button
                        disabled={!picked}
                        aria-disabled={!picked}
                        onClick={() => picked && onPick(picked.start, picked.end)}
                    >
                        {t("freeBusy.useTime")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
