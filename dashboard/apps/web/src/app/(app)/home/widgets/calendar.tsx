"use client";

/**
 * The Overview's "Coming up" card: the next few events from the calendars the
 * reader shows, drawn by the Calendar app's server and listed here with the
 * day and time in the reader's own zone.
 */

import Link from "next/link";
import type { Loaded } from "./infrastructure";
import type { OverviewCalendar } from "@/lib/overview/overview-service";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    WidgetEmpty,
    WidgetList,
    WidgetRow,
    WidgetRowsSkeleton,
    WidgetUnavailable
} from "../widget-card";

/** When an event starts, as the row's second line: "Today 14:30", "Fri 3 Oct". */
function when(
    start: string,
    allDay: boolean,
    locale: string,
    words: { today: string; tomorrow: string }
): string {
    const date = new Date(start);
    const now = new Date();
    const day = (value: Date) =>
        allDay
            ? value.toISOString().slice(0, 10)
            : `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
    const tomorrow = new Date(now.getTime() + 86_400_000);
    const time = allDay
        ? ""
        : new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
    const today = allDay ? now.toISOString().slice(0, 10) : day(now);
    const next = allDay ? tomorrow.toISOString().slice(0, 10) : day(tomorrow);
    const label =
        day(date) === today
            ? words.today
            : day(date) === next
              ? words.tomorrow
              : new Intl.DateTimeFormat(locale, {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                    ...(allDay ? { timeZone: "UTC" } : {})
                }).format(date);
    return time ? `${label} ${time}` : label;
}

export function CalendarWidget({ data }: { data: Loaded<OverviewCalendar> }) {
    const t = useTranslations("home");
    const locale = useLocale();
    if (data === undefined) return <WidgetRowsSkeleton />;
    if (data === null) return <WidgetUnavailable>{t("calendar.unavailable")}</WidgetUnavailable>;
    if (data.events.length === 0) {
        return (
            <WidgetEmpty
                action={
                    <Link
                        href="/calendar"
                        className="text-xs font-medium text-primary hover:underline"
                    >
                        {t("calendar.open")}
                    </Link>
                }
            >
                {t("calendar.empty")}
            </WidgetEmpty>
        );
    }
    const words = { today: t("calendar.today"), tomorrow: t("calendar.tomorrow") };
    return (
        <WidgetList>
            {data.events.map((event) => (
                <WidgetRow
                    key={`${event.id}:${event.start}`}
                    href={event.href}
                    icon={
                        <span
                            aria-hidden="true"
                            className="size-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: event.color }}
                        />
                    }
                    label={event.title || t("calendar.untitled")}
                    detail={when(event.start, event.allDay, locale, words)}
                />
            ))}
        </WidgetList>
    );
}
