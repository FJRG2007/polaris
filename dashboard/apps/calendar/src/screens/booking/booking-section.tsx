"use client";

/**
 * The calendar sidebar's booking pages: each one's address a press away, and
 * the way to the full list. Plugged into `calendarSlots.BookingPagesSection`.
 */

import Link from "next/link";
import { Plus } from "lucide-react";
import { useCalendarT } from "../i18n";
import { CopyButton, Skeleton, cn } from "@polaris/ui";
import type { SidebarSectionSlotProps } from "../slots";
import { bookingUrl, useBookingPages, useLinkBase } from "./reads";

export function BookingPagesSection(_props: SidebarSectionSlotProps) {
    const t = useCalendarT();
    const pages = useBookingPages();
    const base = useLinkBase();
    const list = pages.data ?? [];

    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2 px-1">
                <h3 className="text-[11px] font-medium uppercase tracking-wider text-foreground-subtle">{t("bookingPage.sidebarTitle")}</h3>
                <Link href="/calendar/booking" className="text-xs text-muted-foreground hover:text-foreground">
                    {t("bookingPage.manage")}
                </Link>
            </div>
            {pages.loading ? (
                <div className="flex flex-col gap-1.5 px-1 py-1" aria-busy>
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3.5 w-24" />
                </div>
            ) : list.length === 0 ? (
                <Link href="/calendar/booking/new" className="flex items-center gap-1.5 rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground">
                    <Plus className="size-3.5" />
                    {t("bookingPage.new")}
                </Link>
            ) : (
                <ul className="flex flex-col">
                    {list.map((page) => (
                        <li key={page.id} className="group flex min-w-0 items-center gap-1 rounded px-1 hover:bg-card-hover">
                            <Link
                                href={`/calendar/booking/${page.id}`}
                                className={cn("min-w-0 flex-1 truncate py-1 text-[13px]", page.enabled ? "text-foreground" : "text-foreground-subtle line-through")}
                                title={page.enabled ? page.title : t("bookingPage.offTitle", { title: page.title })}
                            >
                                {page.title}
                            </Link>
                            {base && page.enabled ? (
                                <span className="md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                                    <CopyButton value={bookingUrl(base, page.slug)} label={t("bookingPage.copyLink")} />
                                </span>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
