"use client";

/**
 * A published calendar as anybody with its link sees it, and the same grid for
 * the embed a web page frames. Read-only: month, week and list, in the
 * visitor's own zone (switchable). What is drawn is exactly what the range
 * route answers for the link's mode - a busy-only link gets blocks labelled
 * "Busy" and nothing else.
 *
 * The page's frame paints at once; the window's events arrive after.
 */

import * as time from "../time";
import { StatusNote } from "./kit";
import { useCalendarT } from "../i18n";
import { ZonePicker } from "../zone-picker";
import type { PublicView } from "./public-grid";
import { hostUi } from "@polaris/app-host/client";
import type { EventInput } from "@fullcalendar/core";
import type { OccurrenceView } from "../../lib/wire";
import { cacheKey, useCachedRead } from "../cached-read";
import { lazy, Suspense, useMemo, useState } from "react";
import { Button, cn, SegmentedControl } from "@polaris/ui";
import {
    CalendarPlus,
    Check,
    ChevronLeft,
    ChevronRight,
    Copy,
    Download,
    ExternalLink,
    Globe,
    Loader2
} from "lucide-react";

const PublicGrid = lazy(() => import("./public-grid"));

interface RangeAnswer {
    readonly occurrences: readonly OccurrenceView[];
}

export interface PublicCalendarProps {
    readonly token: string;
    readonly name: string;
    readonly color: string;
    readonly description: string;
    readonly mode: "busy" | "full";
    /** The configured Polaris address every link is built on. */
    readonly base: string;
    /** Drawn inside somebody's page: no header, the grid fills the frame. */
    readonly embed?: boolean;
}

/** Monday first, except where the reader's locale starts on Sunday. */
function firstDayFor(locale: string): number {
    return /^en-US$|^es-US$|^pt-BR$/.test(locale) ? 0 : 1;
}

export function PublicCalendar({
    token,
    name,
    color,
    description,
    mode,
    base,
    embed = false
}: PublicCalendarProps) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const [zone, setZone] = useState(() => time.browserZone());
    const [zoneOpen, setZoneOpen] = useState(false);
    const [view, setView] = useState<PublicView>("month");
    const [anchor, setAnchor] = useState(() => time.todayIn(time.browserZone(), new Date()));
    const firstDay = firstDayFor(locale);

    const days = time.viewWindow(view, anchor, firstDay, 7);
    const instants = time.windowInstants(days, zone);
    const from = instants.from.toISOString();
    const to = instants.to.toISOString();
    const range = useCachedRead<RangeAnswer>(
        cacheKey("public", token, from, to, zone),
        async (signal) => {
            const query = new URLSearchParams({ from, to, zone });
            const response = await fetch(
                `/api/calendar/public/${encodeURIComponent(token)}/range?${query.toString()}`,
                { signal, cache: "no-store" }
            );
            if (!response.ok) throw new Error(t("publicPage.loadFailed"));
            return (await response.json()) as RangeAnswer;
        }
    );

    const busyLabel = t("published.busy");
    const events = useMemo<EventInput[]>(
        () =>
            (range.data?.occurrences ?? []).map((occurrence) => {
                const title = occurrence.summary || busyLabel;
                return {
                    id: `${occurrence.objectId}:${occurrence.recurrenceKey}`,
                    title,
                    allDay: occurrence.allDay,
                    start:
                        occurrence.allDay && occurrence.startDate
                            ? occurrence.startDate
                            : time.wallOf(occurrence.start, zone),
                    end:
                        occurrence.allDay && occurrence.endDate
                            ? occurrence.endDate
                            : time.wallOf(occurrence.end, zone),
                    backgroundColor: color,
                    borderColor: color,
                    classNames: occurrence.status === "TENTATIVE" ? ["pc-tentative"] : [],
                    extendedProps: {
                        label: occurrence.location ? `${title}, ${occurrence.location}` : title
                    }
                };
            }),
        [range.data, zone, color, busyLabel]
    );

    const root = base.replace(/\/+$/, "");
    const pageUrl = `${root}/cal/p/${token}`;
    const feedUrl = `${root}/api/calendar/public/${token}/feed.ics`;
    const webcalUrl = feedUrl.replace(/^https?:\/\//i, "webcal://");

    const toolbar = (
        <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
                <Button
                    size="icon-sm"
                    variant="outline"
                    onClick={() => setAnchor((day) => time.stepAnchor(view, day, -1, 7))}
                    aria-label={t("publicPage.previous")}
                    title={t("publicPage.previous")}
                >
                    <ChevronLeft aria-hidden />
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setAnchor(time.todayIn(zone, new Date()))}
                >
                    {t("publicPage.today")}
                </Button>
                <Button
                    size="icon-sm"
                    variant="outline"
                    onClick={() => setAnchor((day) => time.stepAnchor(view, day, 1, 7))}
                    aria-label={t("publicPage.next")}
                    title={t("publicPage.next")}
                >
                    <ChevronRight aria-hidden />
                </Button>
            </div>
            <span className="min-w-0 truncate font-medium" aria-live="polite">
                {time.windowLabel(view, anchor, days, locale)}
            </span>
            {range.loading || (range.data && range.stale) ? (
                <Loader2 className="size-3.5 animate-spin text-foreground-subtle" aria-hidden />
            ) : null}
            <div className="ml-auto flex items-center gap-1">
                <SegmentedControl<PublicView>
                    size="sm"
                    value={view}
                    onValueChange={setView}
                    aria-label={t("publicPage.viewLabel")}
                    options={[
                        { value: "month", label: t("publicPage.views.month") },
                        { value: "week", label: t("publicPage.views.week") },
                        { value: "list", label: t("publicPage.views.list") }
                    ]}
                />
                <Button
                    size="icon-sm"
                    variant={zoneOpen ? "secondary" : "ghost"}
                    onClick={() => setZoneOpen((open) => !open)}
                    aria-expanded={zoneOpen}
                    aria-label={`${t("publicPage.zone")}: ${zone}`}
                    title={`${t("publicPage.zone")}: ${zone}`}
                >
                    <Globe aria-hidden />
                </Button>
                {embed ? (
                    <Button size="icon-sm" variant="ghost" asChild>
                        <a
                            href={pageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={t("embed.openFull")}
                            title={t("embed.openFull")}
                        >
                            <ExternalLink aria-hidden />
                        </a>
                    </Button>
                ) : null}
            </div>
        </div>
    );

    const grid = (
        <div
            className={cn(
                "relative min-h-0 overflow-hidden rounded-lg border border-border bg-card",
                embed ? "flex-1" : "h-[70vh] min-h-[28rem]"
            )}
        >
            <Suspense fallback={<div className="h-full animate-pulse bg-muted/40" aria-hidden />}>
                <PublicGrid
                    view={view}
                    anchor={anchor}
                    listDays={time.LIST_DAYS}
                    firstDay={firstDay}
                    locale={locale}
                    now={time.wallOf(new Date(), zone)}
                    events={events}
                    words={{
                        allDay: t("publicPage.allDay"),
                        noEvents: t("publicPage.noEvents"),
                        week: t("publicPage.week"),
                        more: (count) => t("publicPage.more", { count })
                    }}
                />
            </Suspense>
        </div>
    );

    const problem = range.error ? (
        <div className="flex items-center gap-2">
            <StatusNote tone="danger" className="flex-1">
                {t("publicPage.loadFailed")}
            </StatusNote>
            <Button size="sm" variant="outline" onClick={range.refresh}>
                {t("publicPage.retry")}
            </Button>
        </div>
    ) : null;

    const zonePicker = zoneOpen ? (
        <div className="max-w-sm">
            <ZonePicker
                value={zone}
                label={t("publicPage.zone")}
                onChange={(next) => {
                    setZone(next);
                    setZoneOpen(false);
                }}
            />
        </div>
    ) : null;

    if (embed) {
        return (
            <div className="flex h-dvh flex-col gap-2 bg-background p-2 text-foreground">
                {toolbar}
                {zonePicker}
                {problem}
                {grid}
            </div>
        );
    }

    return (
        <main className="min-h-dvh bg-background px-4 py-6 text-foreground sm:py-10">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
                <header className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                        <h1 className="flex min-w-0 items-center gap-2 text-[17px] font-semibold tracking-tight">
                            <span
                                aria-hidden
                                className="inline-block size-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: color }}
                            />
                            <span className="min-w-0 truncate" title={name}>
                                {name}
                            </span>
                        </h1>
                        {description ? (
                            <p className="whitespace-pre-wrap text-muted-foreground">
                                {description}
                            </p>
                        ) : null}
                        {mode === "busy" ? (
                            <p className="text-xs text-foreground-subtle">
                                {t("publicPage.busyNote")}
                            </p>
                        ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" asChild>
                            <a href={webcalUrl} title={t("publicPage.subscribeHint")}>
                                <CalendarPlus aria-hidden />
                                {t("publicPage.subscribe")}
                            </a>
                        </Button>
                        <CopyLinkButton value={pageUrl} />
                        <Button size="sm" variant="outline" asChild>
                            <a href={feedUrl} download>
                                <Download aria-hidden />
                                {t("publicPage.download")}
                            </a>
                        </Button>
                    </div>
                </header>
                {toolbar}
                {zonePicker}
                {problem}
                {grid}
            </div>
        </main>
    );
}

function CopyLinkButton({ value }: { value: string }) {
    const t = useCalendarT();
    const [copied, setCopied] = useState(false);
    async function copy(): Promise<void> {
        if (!navigator.clipboard) return;
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            return;
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }
    return (
        <Button size="sm" variant="outline" onClick={() => void copy()}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            <span aria-live="polite">
                {copied ? t("publicPage.copied") : t("publicPage.copyLink")}
            </span>
        </Button>
    );
}
