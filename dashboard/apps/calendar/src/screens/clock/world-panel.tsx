"use client";

/**
 * The world clock: the reader's own time, then each saved city's - its time,
 * whether that is yesterday or tomorrow there, how many hours apart, its zone,
 * and a warning when its clocks change in the next fortnight. Under it, the
 * meeting planner lines one chosen time up across all of them.
 *
 * The cities are the calendar setting `worldClock`, so the sidebar's clocks and
 * the comparison under an event's times are the same list.
 */

import { useNow } from "../ui";
import { useState } from "react";
import * as words from "./words";
import { useCalendarT } from "../i18n";
import { ZonePicker } from "../zone-picker";
import * as cities from "../../lib/clock/cities";
import { hostUi } from "@polaris/app-host/client";
import { MeetingPlanner } from "./meeting-planner";
import { WORLD_CLOCK_MAX, type CalendarPreferences } from "../../lib/preferences";
import { ArrowDown, ArrowUp, Globe2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    EmptyState,
    Skeleton,
    useToast
} from "@polaris/ui";

export function WorldPanel({
    zone,
    hour12,
    preferences,
    ready,
    onCities
}: {
    zone: string;
    hour12: boolean;
    preferences: CalendarPreferences;
    /** The settings have been read: until then the list is not known. */
    ready: boolean;
    onCities: (zones: string[]) => Promise<void>;
}) {
    const t = useCalendarT();
    const toast = useToast();
    const locale = hostUi.i18nProvider.useLocale();
    const now = useNow(15_000);
    const [adding, setAdding] = useState(false);
    const saved = preferences.worldClock;
    const options = cities.cityOptions(locale, now);
    const byZone = new Map(options.map((option) => [option.zone, option]));

    const save = (next: string[]) =>
        void onCities(next).catch((caught: unknown) =>
            toast.show({
                key: "calendar-time",
                title: caught instanceof Error && caught.message ? caught.message : t("screen.failed")
            })
        );

    const move = (index: number, by: -1 | 1) => {
        const next = [...saved];
        const [entry] = next.splice(index, 1);
        next.splice(index + by, 0, entry!);
        save(next);
    };

    const home = byZone.get(zone);

    return (
        <section aria-label={t("time.tabs.world")} className="flex flex-col gap-6">
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">{t("time.world.here")}</p>
                <p className="text-4xl font-semibold tabular-nums tracking-tight">
                    {words.instantTimeText(now, locale, zone, hour12)}
                </p>
                <p className="truncate text-[0.8125rem] text-muted-foreground" title={zone}>
                    {new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: zone }).format(now)}
                    {" · "}
                    {home ? [home.city, home.zoneName].filter(Boolean).join(" · ") : zone}
                </p>
            </div>

            <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                    <h2 className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">{t("time.world.cities")}</h2>
                    {saved.length < WORLD_CLOCK_MAX ? (
                        <Button size="sm" variant="outline" onClick={() => setAdding(!adding)} disabled={!ready} aria-expanded={adding}>
                            <Plus />
                            {t("time.world.add")}
                        </Button>
                    ) : null}
                </div>
                {adding ? (
                    <div className="w-full sm:max-w-md">
                        <ZonePicker
                            value=""
                            cities
                            label={t("time.world.add")}
                            placeholder={t("time.world.searchHint")}
                            onChange={(picked) => {
                                setAdding(false);
                                if (picked && !saved.includes(picked) && picked !== zone) save([...saved, picked]);
                            }}
                        />
                    </div>
                ) : null}

                {!ready ? (
                    <div className="flex flex-col gap-2" aria-hidden>
                        {[0, 1].map((index) => (
                            <Skeleton key={index} className="h-16 w-full" />
                        ))}
                    </div>
                ) : saved.length === 0 ? (
                    <EmptyState
                        icon={<Globe2 />}
                        title={t("time.world.emptyTitle")}
                        description={t("time.world.emptyBody")}
                        action={
                            <Button size="sm" onClick={() => setAdding(true)}>
                                <Plus />
                                {t("time.world.add")}
                            </Button>
                        }
                    />
                ) : (
                    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                        {saved.map((cityZone, index) => {
                            const option = byZone.get(cityZone);
                            const name = option?.city ?? cities.cityOf(cityZone);
                            let time = "-";
                            try {
                                time = words.instantTimeText(now, locale, cityZone, hour12);
                            } catch {
                                time = "-";
                            }
                            const day = cities.dayDifference(cityZone, zone, now);
                            const change = cities.nextClockChange(cityZone, now);
                            return (
                                <li key={cityZone} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-[0.875rem] font-medium" title={cityZone}>
                                            {name}
                                            {option?.country ? (
                                                <span className="font-normal text-muted-foreground">{`, ${option.country}`}</span>
                                            ) : null}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {words.dayWord(day, t)}
                                            {", "}
                                            {words.offsetDifferenceText(cities.offsetBetween(cityZone, zone, now), t)}
                                            {option?.abbreviation ? ` · ${option.abbreviation}` : null}
                                        </p>
                                        {change ? (
                                            <p className="truncate text-xs text-warning-ink">
                                                {t("time.world.clocksChange", {
                                                    when: new Intl.DateTimeFormat(locale, {
                                                        weekday: "short",
                                                        day: "numeric",
                                                        month: "short",
                                                        timeZone: cityZone
                                                    }).format(change)
                                                })}
                                            </p>
                                        ) : null}
                                    </div>
                                    <p className="shrink-0 text-2xl font-semibold tabular-nums tracking-tight">{time}</p>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button size="icon-sm" variant="ghost" aria-label={t("time.more")} title={t("time.more")}>
                                                <MoreHorizontal />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            {index > 0 ? (
                                                <DropdownMenuItem onSelect={() => move(index, -1)}>
                                                    <ArrowUp />
                                                    {t("time.world.moveUp")}
                                                </DropdownMenuItem>
                                            ) : null}
                                            {index < saved.length - 1 ? (
                                                <DropdownMenuItem onSelect={() => move(index, 1)}>
                                                    <ArrowDown />
                                                    {t("time.world.moveDown")}
                                                </DropdownMenuItem>
                                            ) : null}
                                            <DropdownMenuItem onSelect={() => save(saved.filter((entry) => entry !== cityZone))}>
                                                <Trash2 />
                                                {t("time.world.remove")}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            <MeetingPlanner
                zone={zone}
                cities={saved}
                hour12={hour12}
                workingHours={preferences.workingHours}
                ready={ready}
            />
        </section>
    );
}
