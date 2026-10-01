"use client";

/** The booking pages one person lists publicly. */

import { useCalendarT } from "../i18n";
import { EmptyState } from "@polaris/ui";
import { PublicFrame } from "./kit";
import { CalendarClock, ChevronRight, Clock } from "lucide-react";
import type { PublicBookingPage } from "../../lib/scheduling-wire";

export function BookingOverview({
    title,
    pages
}: {
    title: string;
    pages: readonly PublicBookingPage[];
}) {
    const t = useCalendarT();
    return (
        <PublicFrame title={title}>
            {pages.length === 0 ? (
                <EmptyState
                    icon={<CalendarClock />}
                    title={t("booking.overviewEmpty")}
                    description={t("booking.overviewEmptyBody")}
                />
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {pages.map((page) => (
                        <li key={page.slug}>
                            <a
                                href={`/cal/book/${page.slug}`}
                                className="flex items-center gap-3 px-4 py-3 hover:bg-card-hover"
                            >
                                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <span className="truncate font-medium" title={page.title}>
                                        {page.title}
                                    </span>
                                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                        <Clock className="size-3.5" />
                                        {t("bookingPage.minutes", { n: page.durationMinutes })}
                                    </span>
                                    {page.description ? (
                                        <span className="line-clamp-2 text-xs text-foreground-subtle">
                                            {page.description}
                                        </span>
                                    ) : null}
                                </span>
                                <ChevronRight className="size-4 text-foreground-subtle" />
                            </a>
                        </li>
                    ))}
                </ul>
            )}
        </PublicFrame>
    );
}
