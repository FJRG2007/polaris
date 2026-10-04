"use client";

/** The bookings made on one page: what is coming, what is past or cancelled. */

import Link from "next/link";
import { useState } from "react";
import { browserZone } from "../time";
import { EmailLink } from "../contact-links";
import { useCalendarT } from "../i18n";
import { hostUi } from "@polaris/app-host/client";
import { formatRange, StatusNote } from "../public/kit";
import type { BookingView } from "../../lib/scheduling-wire";
import { CalendarX, ExternalLink, Inbox } from "lucide-react";
import { cacheKey, unwrap, useCachedRead } from "../cached-read";
import { cancelBookingAsOwnerAction, listBookingsAction } from "../../actions/booking";
import { Button, EmptyState, Skeleton, SegmentedControl, buttonVariants, cn } from "@polaris/ui";

function StatusChip({ status }: { status: BookingView["status"] }) {
    const t = useCalendarT();
    const tone =
        status === "confirmed"
            ? "border-success-edge bg-success-soft text-success-ink"
            : status === "pending"
              ? "border-warning-edge bg-warning-soft text-warning-ink"
              : "border-border bg-muted text-muted-foreground";
    const label =
        status === "confirmed"
            ? t("booking.statusConfirmed")
            : status === "pending"
              ? t("booking.statusPending")
              : t("booking.statusCancelled");
    return (
        <span
            className={cn(
                "inline-flex h-5 shrink-0 items-center rounded border px-1.5 text-[11px] font-medium",
                tone
            )}
        >
            {label}
        </span>
    );
}

export function BookingsList({ pageId }: { pageId: string }) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const zone = browserZone();
    const [scope, setScope] = useState<"upcoming" | "past">("upcoming");
    const [problem, setProblem] = useState<string | null>(null);
    const [confirm, confirmNode] = hostUi.confirmDialog.useConfirm();
    const read = useCachedRead(
        cacheKey("bookings", pageId),
        async () => (await unwrap(() => listBookingsAction(pageId), t("errors.generic"))).bookings
    );

    const now = Date.now();
    const all = read.data ?? [];
    const upcoming = all
        .filter((booking) => booking.status !== "cancelled" && Date.parse(booking.end) >= now)
        .reverse();
    const past = all.filter(
        (booking) => booking.status === "cancelled" || Date.parse(booking.end) < now
    );
    const shown = scope === "upcoming" ? upcoming : past;

    async function cancel(booking: BookingView) {
        const sure = await confirm({
            title: t("booking.cancelTitle", { name: booking.name }),
            description: t("booking.cancelOwnerBody"),
            confirmLabel: t("booking.cancelBooking"),
            cancelLabel: t("booking.keepBooking"),
            danger: true
        });
        if (!sure) return;
        setProblem(null);
        const before = all;
        read.replace(
            all.map((entry) =>
                entry.id === booking.id ? { ...entry, status: "cancelled" } : entry
            )
        );
        const answer = await hostUi.runAction.runAction(
            () => cancelBookingAsOwnerAction(booking.id),
            setProblem
        );
        if (!answer || !answer.ok) {
            read.replace(before);
            if (answer && !answer.ok) setProblem(answer.error);
        }
    }

    return (
        <section className="flex flex-col gap-3">
            {confirmNode}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">{t("booking.bookingsTitle")}</h2>
                <SegmentedControl
                    size="sm"
                    value={scope}
                    onValueChange={setScope}
                    aria-label={t("booking.bookingsTitle")}
                    options={[
                        { value: "upcoming", label: t("booking.upcoming") },
                        { value: "past", label: t("booking.pastAndCancelled") }
                    ]}
                />
            </div>
            {problem ? <StatusNote tone="danger">{problem}</StatusNote> : null}
            {read.error && !read.data ? <StatusNote tone="danger">{read.error}</StatusNote> : null}
            {read.loading ? (
                <ul
                    className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card"
                    aria-busy
                >
                    {[0, 1].map((row) => (
                        <li key={row} className="flex flex-col gap-1.5 px-3 py-3">
                            <Skeleton className="h-4 w-40" />
                            <Skeleton className="h-3 w-56 max-w-full" />
                        </li>
                    ))}
                </ul>
            ) : read.data && shown.length === 0 ? (
                <EmptyState
                    bare
                    icon={<Inbox />}
                    title={scope === "upcoming" ? t("booking.noUpcoming") : t("booking.noPast")}
                    description={scope === "upcoming" ? t("booking.noUpcomingBody") : undefined}
                />
            ) : shown.length > 0 ? (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {shown.map((booking) => (
                        <li key={booking.id} className="flex flex-col gap-1.5 px-3 py-2.5">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="min-w-0 truncate font-medium" title={booking.name}>
                                    {booking.name}
                                </span>
                                <StatusChip status={booking.status} />
                                <span className="ml-auto flex items-center gap-1">
                                    {booking.objectId && booking.status === "confirmed" ? (
                                        <Link
                                            href={`/calendar/e/${booking.objectId}`}
                                            aria-label={t("booking.openEvent")}
                                            title={t("booking.openEvent")}
                                            className={buttonVariants({
                                                size: "icon-sm",
                                                variant: "ghost"
                                            })}
                                        >
                                            <ExternalLink />
                                        </Link>
                                    ) : null}
                                    {booking.status !== "cancelled" &&
                                    Date.parse(booking.end) >= now ? (
                                        <Button
                                            size="icon-sm"
                                            variant="ghost"
                                            onClick={() => void cancel(booking)}
                                            aria-label={t("booking.cancelBooking")}
                                            title={t("booking.cancelBooking")}
                                        >
                                            <CalendarX />
                                        </Button>
                                    ) : null}
                                </span>
                            </div>
                            <span className="text-muted-foreground">
                                {formatRange(booking.start, booking.end, zone, locale)}
                            </span>
                            <EmailLink
                                address={booking.email}
                                className="w-fit max-w-full truncate text-xs text-muted-foreground no-underline underline-offset-2 hover:underline"
                            />
                            {booking.answers.length > 0 ? (
                                <dl className="grid grid-cols-1 gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[max-content_1fr]">
                                    {booking.answers.map((answer, index) => (
                                        <div key={index} className="contents">
                                            <dt className="text-foreground-subtle">
                                                {answer.label}
                                            </dt>
                                            <dd className="whitespace-pre-wrap break-words text-muted-foreground">
                                                {answer.value}
                                            </dd>
                                        </div>
                                    ))}
                                </dl>
                            ) : null}
                        </li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}
