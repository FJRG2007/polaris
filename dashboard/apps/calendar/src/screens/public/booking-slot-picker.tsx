"use client";

/**
 * Picking a time on a booking page: a month of days, the ones with room
 * marked, and the open times of the day chosen - all in the visitor's zone,
 * which they can change. Used to book and to move a booking.
 */

import * as engine from "../../engine";
import { useCalendarT } from "../i18n";
import { ZonePicker } from "../zone-picker";
import { formatTime, StatusNote } from "./kit";
import { hostUi } from "@polaris/app-host/client";
import { Button, Skeleton, cn } from "@polaris/ui";
import type { SlotView } from "../../lib/scheduling-wire";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Globe } from "lucide-react";
import { addMonths, dayStart, firstOfMonth, formatDay, monthGrid, todayIn, weekdayLabels } from "../time";

type Load = { status: "loading" } | { status: "ready"; slots: SlotView[] } | { status: "error"; message: string };

/** Monday first: what most of the places a booking page is sent to expect. */
const FIRST_DAY = 1;

export function SlotPicker({
    slug,
    zone,
    onZoneChange,
    horizonDays,
    selected,
    onPick,
    revision = 0
}: {
    slug: string;
    zone: string;
    onZoneChange: (zone: string) => void;
    horizonDays: number;
    /** The start of the slot chosen, if any. */
    selected: string | null;
    onPick: (slot: SlotView) => void;
    /** Bumped when the offered times are known to have changed (a slot was
     *  just taken): what was kept is read again. */
    revision?: number;
}) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const today = todayIn(zone, new Date());
    const lastDay = engine.addDays(today, horizonDays);
    const [month, setMonth] = useState(() => firstOfMonth(today));
    const [day, setDay] = useState<string | null>(null);
    const [load, setLoad] = useState<Load>({ status: "loading" });
    const [zoneOpen, setZoneOpen] = useState(false);
    const [turn, setTurn] = useState(0);
    const kept = useRef(new Map<string, SlotView[]>());

    useEffect(() => {
        const key = `${month}|${zone}|${revision}`;
        const held = kept.current.get(key);
        if (held && turn === 0) {
            setLoad({ status: "ready", slots: held });
            return;
        }
        const controller = new AbortController();
        setLoad({ status: "loading" });
        const from = dayStart(month, zone).toISOString();
        const to = dayStart(addMonths(month, 1), zone).toISOString();
        fetch(`/api/calendar/book/${encodeURIComponent(slug)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { signal: controller.signal })
            .then(async (response) => {
                if (response.status === 429) throw new Error(t("booking.slowDown"));
                if (response.status === 404) throw new Error(t("booking.pageGone"));
                if (!response.ok) throw new Error(t("booking.slotsFailed"));
                const body = (await response.json()) as { slots: SlotView[] };
                kept.current.set(key, body.slots);
                setLoad({ status: "ready", slots: body.slots });
            })
            .catch((caught: unknown) => {
                if (controller.signal.aborted) return;
                setLoad({ status: "error", message: caught instanceof Error ? caught.message : t("booking.slotsFailed") });
            });
        return () => controller.abort();
        // `t` is stable for a page; the month, the zone and a retry decide a read.
    }, [slug, month, zone, turn, revision]);

    const byDay = useMemo(() => {
        const found = new Map<string, SlotView[]>();
        if (load.status !== "ready") return found;
        for (const slot of load.slots) {
            const date = engine.localDate(new Date(slot.start), zone);
            found.set(date, [...(found.get(date) ?? []), slot]);
        }
        return found;
    }, [load, zone]);

    // The first day with room is opened for the visitor.
    const openDay = day && byDay.has(day) ? day : ([...byDay.keys()].sort()[0] ?? null);
    const times = openDay ? (byDay.get(openDay) ?? []) : [];
    const weeks = monthGrid(month, FIRST_DAY);
    const labels = weekdayLabels(locale, FIRST_DAY, "short");
    const canBack = month > firstOfMonth(today);
    const canForward = addMonths(month, 1) <= lastDay;
    const monthLabel = formatDay(month, locale, { month: "long", year: "numeric" });

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
                <button
                    type="button"
                    onClick={() => setZoneOpen((open) => !open)}
                    aria-expanded={zoneOpen}
                    className="flex w-fit max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                    <Globe className="size-3.5" />
                    <span className="truncate">{t("booking.timesIn", { zone: engine.zoneLabel(zone, new Date(), locale) })}</span>
                </button>
                {zoneOpen ? (
                    <ZonePicker
                        value={zone}
                        label={t("booking.yourZone")}
                        onChange={(next) => {
                            onZoneChange(next);
                            setZoneOpen(false);
                            setDay(null);
                        }}
                    />
                ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                        <span className="font-medium capitalize">{monthLabel}</span>
                        <span className="flex gap-1">
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                disabled={!canBack}
                                onClick={() => {
                                    setMonth(addMonths(month, -1));
                                    setDay(null);
                                }}
                                aria-label={t("booking.previousMonth")}
                                title={t("booking.previousMonth")}
                            >
                                <ChevronLeft />
                            </Button>
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                disabled={!canForward}
                                onClick={() => {
                                    setMonth(addMonths(month, 1));
                                    setDay(null);
                                }}
                                aria-label={t("booking.nextMonth")}
                                title={t("booking.nextMonth")}
                            >
                                <ChevronRight />
                            </Button>
                        </span>
                    </div>
                    <div role="grid" aria-label={monthLabel} className="grid grid-cols-7 gap-1 text-center" aria-busy={load.status === "loading"}>
                        {labels.map((label) => (
                            <span key={label} role="columnheader" className="pb-1 text-[11px] uppercase tracking-wider text-foreground-subtle">
                                {label}
                            </span>
                        ))}
                        {weeks.flat().map((date) => {
                            const inMonth = date.slice(0, 7) === month.slice(0, 7);
                            const open = byDay.has(date);
                            const chosen = date === openDay;
                            return (
                                <button
                                    key={date}
                                    type="button"
                                    role="gridcell"
                                    disabled={!open}
                                    aria-selected={chosen}
                                    aria-label={formatDay(date, locale, { weekday: "long", day: "numeric", month: "long" })}
                                    onClick={() => setDay(date)}
                                    className={cn(
                                        "flex aspect-square max-h-11 items-center justify-center rounded-md text-[13px] tabular-nums transition-colors duration-fast",
                                        !inMonth && "invisible",
                                        chosen
                                            ? "bg-primary text-primary-foreground"
                                            : open
                                              ? "bg-card font-semibold text-foreground ring-1 ring-inset ring-border hover:bg-card-hover"
                                              : "text-foreground-subtle"
                                    )}
                                >
                                    {Number(date.slice(8))}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="flex flex-col gap-2">
                    {load.status === "loading" ? (
                        <div className="flex flex-col gap-1.5" aria-busy>
                            {[0, 1, 2, 3].map((row) => (
                                <Skeleton key={row} className="h-8 w-full" />
                            ))}
                        </div>
                    ) : load.status === "error" ? (
                        <StatusNote tone="danger">
                            <span>{load.message}</span>{" "}
                            <button type="button" className="underline underline-offset-2" onClick={() => setTurn((value) => value + 1)}>
                                {t("booking.retry")}
                            </button>
                        </StatusNote>
                    ) : times.length === 0 ? (
                        <p className="text-muted-foreground">{byDay.size === 0 ? t("booking.noSlotsMonth") : t("booking.pickDay")}</p>
                    ) : (
                        <>
                            <span className="text-xs text-muted-foreground">{formatDay(openDay!, locale, { weekday: "long", day: "numeric", month: "long" })}</span>
                            <ul className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
                                {times.map((slot) => (
                                    <li key={slot.start}>
                                        <Button
                                            type="button"
                                            variant={selected === slot.start ? "primary" : "outline"}
                                            className="w-full"
                                            aria-pressed={selected === slot.start}
                                            onClick={() => onPick(slot)}
                                        >
                                            {formatTime(slot.start, zone, locale)}
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
