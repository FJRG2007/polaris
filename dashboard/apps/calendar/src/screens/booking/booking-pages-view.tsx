"use client";

/**
 * The owner's booking pages: each with its address to copy, a preview, and the
 * switch that takes it off line without deleting it.
 */

import Link from "next/link";
import { useState } from "react";
import { useCalendarT } from "../i18n";
import { draftOf, inputOf } from "./model";
import { StatusNote } from "../public/kit";
import { hostUi } from "@polaris/app-host/client";
import type { BookingPageView } from "../../lib/scheduling-wire";
import { BookingOffNote } from "./booking-off-note";
import {
    bookingUrl,
    forgetBookingPages,
    useBookingPages,
    useBookingSwitch,
    useLinkBase
} from "./reads";
import { CalendarClock, Copy, CopyPlus, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, CopyButton, EmptyState, Skeleton, Switch, buttonVariants, cn } from "@polaris/ui";
import {
    deleteBookingPageAction,
    duplicateBookingPageAction,
    updateBookingPageAction
} from "../../actions/booking";

export function BookingPagesView() {
    const t = useCalendarT();
    const pages = useBookingPages();
    const base = useLinkBase();
    const switched = useBookingSwitch();
    const off = switched !== null && !switched.allowed;
    const [confirm, confirmNode] = hostUi.confirmDialog.useConfirm();
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const list = pages.data ?? [];
    const put = (next: BookingPageView[]) => pages.replace(next);

    async function run<T extends { ok: boolean }>(
        call: () => Promise<T>
    ): Promise<Extract<T, { ok: true }> | null> {
        setProblem(null);
        const answer = await hostUi.runAction.runAction(call, setProblem);
        if (!answer) return null;
        if (!answer.ok) {
            setProblem((answer as unknown as { error: string }).error);
            return null;
        }
        return answer as Extract<T, { ok: true }>;
    }

    async function toggle(page: BookingPageView, enabled: boolean) {
        const before = list;
        put(list.map((entry) => (entry.id === page.id ? { ...entry, enabled } : entry)));
        const answer = await run(() =>
            updateBookingPageAction(page.id, inputOf({ ...draftOf(page), enabled }))
        );
        if (!answer) put(before);
        else put(before.map((entry) => (entry.id === page.id ? answer.page : entry)));
    }

    async function duplicate(page: BookingPageView) {
        setBusy(page.id);
        const answer = await run(() => duplicateBookingPageAction(page.id));
        setBusy(null);
        if (answer) put([...list, answer.page]);
    }

    async function remove(page: BookingPageView) {
        const sure = await confirm({
            title: t("bookingPage.deleteTitle", { title: page.title }),
            description: t("bookingPage.deleteBody"),
            confirmLabel: t("bookingPage.delete"),
            danger: true
        });
        if (!sure) return;
        const before = list;
        put(list.filter((entry) => entry.id !== page.id));
        const answer = await run(() => deleteBookingPageAction(page.id));
        if (!answer) put(before);
        forgetBookingPages();
    }

    return (
        <div className="flex flex-col gap-4">
            {confirmNode}
            <div className="flex justify-end">
                {off ? (
                    <Button size="sm" disabled>
                        <Plus />
                        {t("bookingPage.new")}
                    </Button>
                ) : (
                    <Link href="/calendar/booking/new" className={buttonVariants({ size: "sm" })}>
                        <Plus />
                        {t("bookingPage.new")}
                    </Link>
                )}
            </div>
            {off ? <BookingOffNote canManage={switched?.canManage ?? false} /> : null}
            {problem ? <StatusNote tone="danger">{problem}</StatusNote> : null}
            {pages.error && !pages.data ? (
                <StatusNote tone="danger">
                    <span>{pages.error}</span>{" "}
                    <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={pages.refresh}
                    >
                        {t("bookingPage.retry")}
                    </button>
                </StatusNote>
            ) : null}
            {pages.loading ? (
                <ul
                    className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card"
                    aria-busy
                >
                    {[0, 1, 2].map((row) => (
                        <li key={row} className="flex items-center gap-3 px-3 py-3">
                            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                                <Skeleton className="h-4 w-48 max-w-full" />
                                <Skeleton className="h-3 w-32" />
                            </div>
                            <Skeleton className="h-5 w-9" />
                        </li>
                    ))}
                </ul>
            ) : pages.data && list.length === 0 ? (
                <EmptyState
                    icon={<CalendarClock />}
                    title={t("bookingPage.emptyTitle")}
                    description={t("bookingPage.emptyBody")}
                    action={
                        off ? undefined : (
                            <Link
                                href="/calendar/booking/new"
                                className={buttonVariants({ size: "sm" })}
                            >
                                <Plus />
                                {t("bookingPage.new")}
                            </Link>
                        )
                    }
                />
            ) : list.length > 0 ? (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {list.map((page) => (
                        <li
                            key={page.id}
                            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
                        >
                            <div className="flex min-w-0 flex-1 flex-col">
                                <Link
                                    href={`/calendar/booking/${page.id}`}
                                    className="truncate font-medium text-foreground hover:underline"
                                    title={page.title}
                                >
                                    {page.title}
                                </Link>
                                <span className="truncate text-xs text-muted-foreground">
                                    {t("bookingPage.minutes", { n: page.durationMinutes })},{" "}
                                    {page.visibility === "public"
                                        ? t("bookingPage.visibilityPublic")
                                        : t("bookingPage.visibilityLink")}
                                    , {t("bookingPage.upcoming", { n: page.upcoming })}
                                </span>
                            </div>
                            <div className="flex items-center gap-1">
                                <Switch
                                    checked={page.enabled}
                                    disabled={off && !page.enabled}
                                    onChange={(value) => void toggle(page, value)}
                                    aria-label={t("bookingPage.enabledFor", { title: page.title })}
                                />
                                {base ? (
                                    <CopyButton
                                        value={bookingUrl(base, page.slug)}
                                        label={t("bookingPage.copyLink")}
                                    />
                                ) : (
                                    <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        disabled
                                        aria-label={t("bookingPage.copyLink")}
                                        title={t("bookingPage.copyLink")}
                                    >
                                        <Copy />
                                    </Button>
                                )}
                                <a
                                    href={`/cal/book/${page.slug}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label={t("bookingPage.preview")}
                                    title={t("bookingPage.preview")}
                                    className={cn(
                                        buttonVariants({ size: "icon-sm", variant: "ghost" })
                                    )}
                                >
                                    <ExternalLink />
                                </a>
                                <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    disabled={busy === page.id}
                                    onClick={() => void duplicate(page)}
                                    aria-label={t("bookingPage.duplicate")}
                                    title={t("bookingPage.duplicate")}
                                >
                                    <CopyPlus />
                                </Button>
                                <Link
                                    href={`/calendar/booking/${page.id}`}
                                    aria-label={t("bookingPage.edit")}
                                    title={t("bookingPage.edit")}
                                    className={cn(
                                        buttonVariants({ size: "icon-sm", variant: "ghost" })
                                    )}
                                >
                                    <Pencil />
                                </Link>
                                <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    onClick={() => void remove(page)}
                                    aria-label={t("bookingPage.delete")}
                                    title={t("bookingPage.delete")}
                                >
                                    <Trash2 />
                                </Button>
                            </div>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}
