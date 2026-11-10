"use client";

/**
 * The sections that read one dimension end to end - Pages, Sources, Geography -
 * and the live view, plus the two pieces they share: a ranked list that scrolls
 * forever, and the world map.
 *
 * A list asks the server for its ranking a page at a time (`breakdown` reports,
 * cursor-paged in `lib/analytics-lists`) and draws only the rows on screen, so a
 * site with four hundred paths costs the same to open as one with four. The
 * first page of each list is kept for the session and drawn at once on the way
 * back, then asked again behind it.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Filter, FilterX, Globe, Radio } from "lucide-react";
import {
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
    SegmentedControl,
    Skeleton,
    TimeSeriesChart,
    cn
} from "@polaris/ui";
import * as core from "@polaris/core";
import * as polls from "./analytics-polls";
import type { NamespaceKey } from "@/lib/i18n/types";
import type { AnalyticsReportAnswer } from "./actions";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { BREAKDOWN_FILTER, Empty, Failure, Rows, useFilterPick, type PanelProps } from "./analytics-reports";

type Breakdown = Extract<AnalyticsReportAnswer, { kind: "breakdown" }>;
type Realtime = Extract<AnalyticsReportAnswer, { kind: "realtime" }>;

function grouped(value: number): string {
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** How a dimension's key reads in a row. */
export function rowLabel(dimension: core.VisitDimension, key: string): string {
    if (dimension === "country") return `${core.countryFlag(key)} ${core.countryName(key)}`;
    return key || "-";
}

// --- the ranked list ---------------------------------------------------------------

/** First pages already read this session, by site, window, filters and dimension. */
const firstPages = new Map<string, Breakdown>();

/** One dimension's ranking, accumulated page by page. */
export function useRanked(props: PanelProps, dimension: core.VisitDimension, limit?: number) {
    const { scope, siteId, filtersParam } = props;
    const range = props.data.range;
    const cacheKey = `${scope}:${siteId}:${range}:${filtersParam}:${dimension}:${limit ?? ""}`;
    const cached = firstPages.get(cacheKey) ?? null;
    const [rows, setRows] = useState<core.VisitRow[] | null>(cached ? cached.rows : null);
    const [next, setNext] = useState<string | null>(cached?.next ?? null);
    const [meta, setMeta] = useState<Pick<Breakdown, "unavailable" | "capped" | "source"> | null>(cached);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inflight = useRef<AbortController | null>(null);

    const fetchPage = useCallback(
        (cursor: string | null) => {
            inflight.current?.abort();
            const controller = new AbortController();
            inflight.current = controller;
            setLoading(true);
            polls
                .analyticsReport(
                    {
                        scopeType: scope,
                        scopeId: siteId,
                        range,
                        filters: filtersParam,
                        request: JSON.stringify({ kind: "breakdown", dimension, cursor, ...(limit ? { limit } : {}) })
                    },
                    controller.signal
                )
                .then((result) => {
                    if (controller.signal.aborted) return;
                    if ("error" in result) {
                        setError(result.error);
                        return;
                    }
                    if (result.kind !== "breakdown") return;
                    setError(null);
                    setMeta(result);
                    setNext(result.next);
                    if (cursor) {
                        setRows((current) => {
                            const seen = new Set((current ?? []).map((row) => row.key));
                            return [...(current ?? []), ...result.rows.filter((row) => !seen.has(row.key))];
                        });
                    } else {
                        firstPages.set(cacheKey, result);
                        if (firstPages.size > 200) firstPages.delete(firstPages.keys().next().value!);
                        setRows(result.rows);
                    }
                })
                .catch(() => {
                    if (!controller.signal.aborted) setRows((current) => current ?? []);
                })
                .finally(() => {
                    if (!controller.signal.aborted) setLoading(false);
                });
        },
        [scope, siteId, range, filtersParam, dimension, limit, cacheKey]
    );

    // A new site, window, filter or dimension: the cached first page, if any, now,
    // and the fresh one behind it.
    useEffect(() => {
        const hit = firstPages.get(cacheKey);
        setRows(hit ? hit.rows : null);
        setNext(hit?.next ?? null);
        setMeta(hit ?? null);
        fetchPage(null);
        return () => inflight.current?.abort();
    }, [cacheKey, fetchPage]);

    const more = useCallback(() => {
        if (next && !loading) fetchPage(next);
    }, [next, loading, fetchPage]);

    return { rows, more, hasMore: next !== null, loading, error, meta };
}

const ROW_HEIGHT = 34;

/**
 * A ranking that scrolls forever: only the rows in view are drawn, and the next
 * page is asked for as the end comes into view. A row narrows the screen to it;
 * its context menu also excludes it or copies it.
 */
export function RankList({
    props,
    dimension,
    empty,
    className,
    onPick,
    picked
}: {
    props: PanelProps;
    dimension: core.VisitDimension;
    empty: string;
    className?: string;
    /** A row click chooses it here instead of narrowing the screen to it. */
    onPick?: (key: string) => void;
    /** The row `onPick` last chose, drawn as chosen. */
    picked?: string | null;
}) {
    const t = useTranslations("analytics");
    const { rows, more, hasMore, loading, error, meta } = useRanked(props, dimension);
    const pick = useFilterPick();
    const narrow = BREAKDOWN_FILTER[dimension];
    const parent = useRef<HTMLDivElement | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const count = rows?.length ?? 0;
    const virtualizer = useVirtualizer({
        count,
        getScrollElement: () => parent.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 10
    });
    const items = virtualizer.getVirtualItems();
    const last = items[items.length - 1]?.index ?? -1;
    useEffect(() => {
        if (hasMore && !loading && last >= count - 8) more();
    }, [last, count, hasMore, loading, more]);

    if (meta?.unavailable) return <Empty>{t("breakdowns.notKept")}</Empty>;
    if (rows === null) return <Rows count={6} />;
    if (rows.length === 0) return error ? <Failure message={error} /> : <Empty>{empty}</Empty>;
    const top = rows[0]?.visitors ?? 0;

    const copy = (value: string) => {
        void navigator.clipboard.writeText(value).then(() => {
            setCopied(value);
            setTimeout(() => setCopied(null), 1500);
        });
    };

    return (
        <div className={cn("flex min-w-0 flex-col gap-1", className)}>
            <div className="flex items-center gap-3 px-2 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">{t("lists.item")}</span>
                <span className="w-16 shrink-0 text-right">{t("lists.visitors")}</span>
                <span className="hidden w-16 shrink-0 text-right sm:inline">
                    {dimension === "event" ? t("lists.events") : t("lists.views")}
                </span>
            </div>
            <div ref={parent} className="max-h-[26rem] min-h-0 overflow-y-auto overscroll-contain" role="list">
                <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                    {items.map((item) => {
                        const row = rows[item.index]!;
                        const label = rowLabel(dimension, row.key);
                        return (
                            <ContextMenu key={row.key}>
                                <ContextMenuTrigger asChild>
                                    <div
                                        role="listitem"
                                        className="absolute left-0 top-0 flex w-full items-center gap-3 text-sm"
                                        style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
                                    >
                                        <span
                                            aria-hidden
                                            className="absolute inset-y-1 left-0 rounded bg-primary/10"
                                            style={{ width: `${top > 0 ? Math.max(2, (row.visitors / top) * 100) : 0}%` }}
                                        />
                                        {onPick ? (
                                            <button
                                                type="button"
                                                className={cn(
                                                    "relative min-w-0 flex-1 truncate pl-2 text-left hover:underline",
                                                    picked === row.key && "font-medium"
                                                )}
                                                aria-pressed={picked === row.key}
                                                title={row.key}
                                                onClick={() => onPick(row.key)}
                                            >
                                                {label}
                                            </button>
                                        ) : pick && narrow ? (
                                            <button
                                                type="button"
                                                className="relative min-w-0 flex-1 truncate pl-2 text-left hover:underline"
                                                title={t("filters.narrowTo", { value: row.key })}
                                                onClick={() => pick(narrow, row.key)}
                                            >
                                                {label}
                                            </button>
                                        ) : (
                                            <span className="relative min-w-0 flex-1 truncate pl-2" title={row.key}>
                                                {label}
                                            </span>
                                        )}
                                        <span className="relative w-16 shrink-0 text-right tabular-nums">
                                            {grouped(row.visitors)}
                                        </span>
                                        <span className="relative hidden w-16 shrink-0 pr-2 text-right tabular-nums text-muted-foreground sm:inline">
                                            {grouped(row.views)}
                                        </span>
                                    </div>
                                </ContextMenuTrigger>
                                <ContextMenuContent className="min-w-[10rem]">
                                    {pick && narrow ? (
                                        <>
                                            <ContextMenuItem onSelect={() => pick(narrow, row.key)}>
                                                <Filter className="size-3.5" />
                                                {t("lists.filterTo")}
                                            </ContextMenuItem>
                                            <ContextMenuItem onSelect={() => pick(narrow, row.key, true)}>
                                                <FilterX className="size-3.5" />
                                                {t("lists.exclude")}
                                            </ContextMenuItem>
                                        </>
                                    ) : null}
                                    <ContextMenuItem onSelect={() => copy(row.key)}>
                                        {copied === row.key ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                                        {copied === row.key ? t("tracker.copied") : t("lists.copy")}
                                    </ContextMenuItem>
                                </ContextMenuContent>
                            </ContextMenu>
                        );
                    })}
                </div>
            </div>
            {loading && rows.length > 0 ? <Skeleton className="mx-2 h-5" /> : null}
            {meta?.capped && !hasMore ? (
                <p className="px-2 text-xs text-muted-foreground">{t("lists.capped")}</p>
            ) : null}
        </div>
    );
}

/** A card holding one ranked list, or several behind a segmented switch. */
function RankCard({
    props,
    title,
    choices
}: {
    props: PanelProps;
    title: string;
    choices: { value: core.VisitDimension; label: string; empty: string }[];
}) {
    const [dimension, setDimension] = useState(choices[0]!.value);
    const choice = choices.find((one) => one.value === dimension) ?? choices[0]!;
    return (
        <Card className="min-w-0">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
                <CardTitle className="text-sm">{title}</CardTitle>
                {choices.length > 1 ? (
                    <SegmentedControl
                        size="sm"
                        value={dimension}
                        onValueChange={setDimension}
                        options={choices.map((one) => ({ value: one.value, label: one.label }))}
                        aria-label={title}
                    />
                ) : null}
            </CardHeader>
            <CardBody className="pt-0">
                <RankList key={choice.value} props={props} dimension={choice.value} empty={choice.empty} />
            </CardBody>
        </Card>
    );
}

export function PagesSection(props: PanelProps) {
    const t = useTranslations("analytics");
    return (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <RankCard
                props={props}
                title={t("breakdowns.pages")}
                choices={[
                    { value: "path", label: t("breakdowns.pages"), empty: t("breakdowns.noPages") },
                    { value: "entry", label: t("breakdowns.entry"), empty: t("breakdowns.noVisits") },
                    { value: "exit", label: t("breakdowns.exit"), empty: t("breakdowns.noVisits") }
                ]}
            />
            <RankCard
                props={props}
                title={t("lists.environment")}
                choices={[
                    { value: "browser", label: t("breakdowns.browsers"), empty: t("breakdowns.nothing") },
                    { value: "os", label: t("breakdowns.systems"), empty: t("breakdowns.nothing") },
                    { value: "device", label: t("breakdowns.devices"), empty: t("breakdowns.nothing") },
                    { value: "screen", label: t("breakdowns.screens"), empty: t("breakdowns.noScreens") }
                ]}
            />
        </div>
    );
}

export function SourcesSection(props: PanelProps) {
    const t = useTranslations("analytics");
    return (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <RankCard
                props={props}
                title={t("breakdowns.referrers")}
                choices={[{ value: "referrer", label: t("breakdowns.referrers"), empty: t("breakdowns.nowhere") }]}
            />
            <RankCard
                props={props}
                title={t("breakdowns.channels")}
                choices={[
                    { value: "channel", label: t("breakdowns.channels"), empty: t("breakdowns.nothing") },
                    { value: "campaign", label: t("breakdowns.campaigns"), empty: t("breakdowns.noCampaigns") }
                ]}
            />
        </div>
    );
}

export function GeographySection(props: PanelProps) {
    const t = useTranslations("analytics");
    // Every country fits in one page, so the map is coloured from the whole list.
    const countries = useRanked(props, "country", 200);
    return (
        <div className="flex flex-col gap-3">
            <Card className="min-w-0">
                <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm">
                        <Globe className="size-4 text-muted-foreground" aria-hidden />
                        {t("map.title")}
                    </CardTitle>
                </CardHeader>
                <CardBody className="pt-0">
                    <WorldMap rows={countries.rows} unavailable={countries.meta?.unavailable ?? false} />
                </CardBody>
            </Card>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <RankCard
                    props={props}
                    title={t("breakdowns.countries")}
                    choices={[{ value: "country", label: t("breakdowns.countries"), empty: t("breakdowns.noCountries") }]}
                />
                <RankCard
                    props={props}
                    title={t("breakdowns.languages")}
                    choices={[{ value: "language", label: t("breakdowns.languages"), empty: t("breakdowns.nothing") }]}
                />
            </div>
        </div>
    );
}

// --- the map -----------------------------------------------------------------------

interface WorldShape {
    w: number;
    h: number;
    sphere: string;
    countries: { c: string; n: string; d: string }[];
}

let world: Promise<WorldShape> | null = null;

/**
 * The outlines, pre-projected (Equal Earth) from Natural Earth's 1:110m countries
 * as published in world-atlas, keyed by ISO 3166-1 alpha-2. Shipped with the app
 * and loaded only when a map is drawn, never from a CDN.
 */
function loadWorld(): Promise<WorldShape> {
    world ??= import("./world-map.json").then((module) => (module.default ?? module) as WorldShape);
    return world;
}

/**
 * Visitors by country, darker where there are more. Colour runs on the square root
 * of the share of the top country, so one dominant country does not leave every
 * other one looking empty. Hovering names a country; picking one narrows the
 * screen to it.
 */
export function WorldMap({ rows, unavailable = false }: { rows: readonly core.VisitRow[] | null; unavailable?: boolean }) {
    const t = useTranslations("analytics");
    const pick = useFilterPick();
    const [shape, setShape] = useState<WorldShape | null>(null);
    const [hover, setHover] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        void loadWorld().then((loaded) => {
            if (live) setShape(loaded);
        });
        return () => {
            live = false;
        };
    }, []);
    const byCode = useMemo(() => new Map((rows ?? []).map((row) => [row.key.toUpperCase(), row])), [rows]);
    const top = useMemo(() => (rows ?? []).reduce((best, row) => Math.max(best, row.visitors), 0), [rows]);
    const hovered = hover ? byCode.get(hover) : undefined;

    if (unavailable) return <Empty>{t("breakdowns.notKept")}</Empty>;
    if (!shape || rows === null) return <Skeleton className="aspect-[2/1] w-full" />;

    return (
        <div className="flex flex-col gap-2">
            <svg
                viewBox={`0 0 ${shape.w} ${shape.h}`}
                className="h-auto w-full"
                role="img"
                aria-label={t("map.title")}
                onMouseLeave={() => setHover(null)}
            >
                <path d={shape.sphere} className="fill-muted/30" />
                {shape.countries.map((country, index) => {
                    const row = country.c ? byCode.get(country.c) : undefined;
                    const share = row && top > 0 ? Math.sqrt(row.visitors / top) : 0;
                    return (
                        <path
                            key={`${country.c}-${index}`}
                            d={country.d}
                            className={cn(
                                "stroke-background transition-opacity",
                                row ? "fill-primary" : "fill-muted",
                                row && pick ? "cursor-pointer" : ""
                            )}
                            strokeWidth={0.5}
                            fillOpacity={row ? 0.2 + 0.8 * share : 1}
                            opacity={hover && hover !== country.c ? 0.75 : 1}
                            onMouseEnter={() => setHover(country.c || null)}
                            onClick={() => {
                                if (row && pick) pick("country", row.key);
                            }}
                        >
                            <title>
                                {row
                                    ? `${core.countryName(country.c)}: ${t("map.visitors", { count: grouped(row.visitors) })}`
                                    : country.c
                                      ? core.countryName(country.c)
                                      : country.n}
                            </title>
                        </path>
                    );
                })}
            </svg>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">
                    {hover
                        ? `${core.countryFlag(hover)} ${core.countryName(hover)}: ${t("map.visitors", {
                              count: grouped(hovered?.visitors ?? 0)
                          })}`
                        : rows.length === 0
                          ? t("breakdowns.noCountries")
                          : t("map.hint")}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                    {t("map.fewer")}
                    <span aria-hidden className="h-2 w-16 rounded-full bg-gradient-to-r from-primary/20 to-primary" />
                    {t("map.more")}
                </span>
            </div>
        </div>
    );
}

// --- right now ---------------------------------------------------------------------

/** How often the live view asks again while it is on screen. */
const REALTIME_EVERY_MS = 10_000;

/** Last answer per site, so coming back shows it at once and refreshes behind it. */
const lastRealtime = new Map<string, Realtime>();

export function RealtimeSection(props: PanelProps) {
    const t = useTranslations("analytics");
    const format = useDisplayFormat();
    const pick = useFilterPick();
    const { scope, siteId, filtersParam } = props;
    const key = `${scope}:${siteId}:${filtersParam}`;
    const [answer, setAnswer] = useState<Realtime | null>(lastRealtime.get(key) ?? null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let controller: AbortController | null = null;
        const ask = () => {
            // A hidden tab keeps its last answer and asks again when it is looked at.
            if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
            controller?.abort();
            controller = new AbortController();
            const signal = controller.signal;
            polls
                .analyticsReport(
                    {
                        scopeType: scope,
                        scopeId: siteId,
                        range: props.data.range,
                        filters: filtersParam,
                        request: JSON.stringify({ kind: "realtime" })
                    },
                    signal
                )
                .then((result) => {
                    if (signal.aborted) return;
                    if ("error" in result) setError(result.error);
                    else if (result.kind === "realtime") {
                        setError(null);
                        lastRealtime.set(key, result);
                        setAnswer(result);
                    }
                })
                .catch(() => undefined);
        };
        setAnswer(lastRealtime.get(key) ?? null);
        ask();
        const timer = setInterval(ask, REALTIME_EVERY_MS);
        document.addEventListener("visibilitychange", ask);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", ask);
            controller?.abort();
        };
    }, [key, scope, siteId, filtersParam, props.data.range]);

    const tiles: { label: string; value: number | null; live?: boolean }[] = [
        { label: t("realtime.online"), value: answer?.online ?? null, live: true },
        { label: t("realtime.visitors"), value: answer?.visitors ?? null },
        { label: t("realtime.views"), value: answer?.views ?? null }
    ];

    return (
        <div className="flex flex-col gap-3">
            <Failure message={error} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {tiles.map((tile) => (
                    <Card key={tile.label} className="min-w-0">
                        <CardBody className="flex flex-col gap-1">
                            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                                {tile.live ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-success" /> : null}
                                <span className="truncate" title={tile.label}>{tile.label}</span>
                            </span>
                            {tile.value === null ? (
                                <Skeleton className="h-7 w-16" />
                            ) : (
                                <span className="text-2xl font-semibold tabular-nums">{grouped(tile.value)}</span>
                            )}
                        </CardBody>
                    </Card>
                ))}
            </div>
            <Card className="min-w-0">
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm">{t("realtime.perMinute")}</CardTitle>
                </CardHeader>
                <CardBody>
                    {answer ? (
                        <TimeSeriesChart
                            points={answer.series.map((point) => ({ t: point.t, v: point.views }))}
                            from={answer.from}
                            to={answer.to}
                            summary="sum"
                            label={t("cards.pageviews")}
                            format={grouped}
                            formatTime={(at) => format.time(at)}
                        />
                    ) : (
                        <Skeleton className="h-[132px] w-full" />
                    )}
                </CardBody>
            </Card>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <Card className="min-w-0">
                    <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm">
                            <Radio className="size-4 text-muted-foreground" aria-hidden />
                            {t("realtime.feed")}
                        </CardTitle>
                    </CardHeader>
                    <CardBody className="pt-0">
                        {!answer ? (
                            <Rows count={6} />
                        ) : answer.feed.length === 0 ? (
                            <Empty>{t("realtime.none")}</Empty>
                        ) : (
                            <ul className="flex max-h-[26rem] flex-col divide-y divide-border overflow-y-auto overscroll-contain">
                                {answer.feed.map((entry, index) => (
                                    <li key={`${entry.sessionId}-${entry.at}-${index}`} className="flex min-w-0 items-center gap-3 py-1.5 text-sm">
                                        <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground">
                                            {format.time(new Date(entry.at).getTime())}
                                        </span>
                                        <span className="shrink-0" aria-hidden>
                                            {entry.country ? core.countryFlag(entry.country) : ""}
                                        </span>
                                        <button
                                            type="button"
                                            className="min-w-0 flex-1 truncate text-left hover:underline"
                                            title={entry.kind === "event" ? (entry.name ?? "") : entry.path}
                                            onClick={() =>
                                                pick?.(entry.kind === "event" ? "event" : "path", entry.kind === "event" ? (entry.name ?? "") : entry.path)
                                            }
                                        >
                                            {entry.kind === "event"
                                                ? t("realtime.event", { name: entry.name ?? "" })
                                                : entry.path}
                                        </button>
                                        <span className="hidden min-w-0 max-w-[8rem] shrink truncate text-xs text-muted-foreground sm:inline">
                                            {entry.browser ?? ""}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardBody>
                </Card>
                <Card className="min-w-0">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm">{t("map.title")}</CardTitle>
                    </CardHeader>
                    <CardBody className="pt-0">
                        <WorldMap rows={answer?.countries ?? null} />
                    </CardBody>
                </Card>
            </div>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <TopCard title={t("breakdowns.pages")} rows={answer?.pages ?? null} dimension="path" empty={t("realtime.none")} />
                <TopCard title={t("breakdowns.referrers")} rows={answer?.referrers ?? null} dimension="referrer" empty={t("breakdowns.nowhere")} />
            </div>
        </div>
    );
}

function TopCard({
    title,
    rows,
    dimension,
    empty
}: {
    title: string;
    rows: readonly core.VisitRow[] | null;
    dimension: core.VisitDimension;
    empty: string;
}) {
    const pick = useFilterPick();
    const narrow = BREAKDOWN_FILTER[dimension];
    const top = rows?.[0]?.visitors ?? 0;
    return (
        <Card className="min-w-0">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm">{title}</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
                {rows === null ? (
                    <Rows />
                ) : rows.length === 0 ? (
                    <Empty>{empty}</Empty>
                ) : (
                    <ul className="flex flex-col">
                        {rows.map((row) => (
                            <li key={row.key} className="relative flex items-center gap-3 py-1.5 text-sm">
                                <span
                                    aria-hidden
                                    className="absolute inset-y-0.5 left-0 rounded bg-primary/10"
                                    style={{ width: `${top > 0 ? Math.max(2, (row.visitors / top) * 100) : 0}%` }}
                                />
                                <button
                                    type="button"
                                    className="relative min-w-0 flex-1 truncate pl-2 text-left hover:underline"
                                    title={row.key}
                                    onClick={() => (pick && narrow ? pick(narrow, row.key) : undefined)}
                                >
                                    {rowLabel(dimension, row.key)}
                                </button>
                                <span className="relative shrink-0 pr-2 tabular-nums">{grouped(row.visitors)}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}

/** The section's name, for the heading over it. */
export function sectionTitleKey(tab: string): NamespaceKey<"analytics"> {
    return `sections.${tab}` as NamespaceKey<"analytics">;
}
