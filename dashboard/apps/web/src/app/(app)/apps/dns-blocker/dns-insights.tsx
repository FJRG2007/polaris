"use client";

/**
 * What the Network filter has been doing over a range: the totals, lookups over
 * time permitted against blocked, the busiest devices over time, query types,
 * who answered, the top names and devices, and the query log with a live view
 * and allow or block on every row. Pausing blocking lives here too.
 *
 * The card's chrome and filters paint at once; each region that waits on the
 * engine has its own skeleton. A domain or device anywhere is a button that
 * filters the log by it, which is what a reader reaches for next.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as polls from "./dns-blocker-polls";
import { serviceName } from "./fields";
import { useUnmountSignal } from "@/lib/poll-fetch";
import {
    Ban,
    ChevronLeft,
    ChevronRight,
    Loader2,
    Pause,
    Play,
    RefreshCw,
    ShieldCheck
} from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Input,
    MultiSeriesChart,
    SegmentedControl,
    Select,
    Skeleton,
    Switch,
    SERIES_COLORS,
    type ChartSeries
} from "@polaris/ui";
import type { NamespaceKey } from "@/lib/i18n/types";
import type { DnsInsights } from "@/lib/dns-blocker/insights";
import type { DnsSettings } from "@/lib/dns-blocker/settings";
import { reputationCategoryOf } from "@/lib/dns-blocker/reputation";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    DNS_RANGE_IDS,
    rangeDays,
    type ClientSeries,
    type DnsRange,
    type EngineMetrics,
    type NameCount,
    type QueryFilter,
    type QueryRow,
    type QueryTimeline,
    queryFilterSchema
} from "@/lib/dns-blocker/query-log";
import {
    dnsListsAction,
    refreshDnsListsAction,
    pauseDnsBlockingAction,
    resumeDnsBlockingAction,
    ruleFromLogAction,
    turnOnDnsBlockerAction
} from "./actions";

export type Translate = ReturnType<typeof useTranslations<"dnsBlocker">>;

/** Pause presets in seconds; 0 is until resumed. */
const PAUSES = [10, 30, 300, 900, 3600, 0] as const;
const LIVE_EVERY_MS = 3000;
export const ALLOWED_COLOR = "hsl(var(--primary))";
export const BLOCKED_COLOR = "hsl(var(--danger))";

const EMPTY_FILTER: QueryFilter = {
    search: "",
    outcome: "all",
    client: "",
    type: "",
    range: "24h",
    page: 0
};

/** Where the query log is, and what a link into it carries. */
export const DNS_LOG_HREF = "/apps/dns-blocker/log";

/** The log's filter as a link: `?client=`, `?domain=`, `?outcome=`, `?type=`, `?range=`. */
export function logHref(patch: Partial<QueryFilter>): string {
    const query = new URLSearchParams();
    if (patch.client) query.set("client", patch.client);
    if (patch.search) query.set("domain", patch.search);
    if (patch.outcome && patch.outcome !== "all") query.set("outcome", patch.outcome);
    if (patch.type) query.set("type", patch.type);
    if (patch.range && patch.range !== "24h") query.set("range", patch.range);
    const text = query.toString();
    return text ? `${DNS_LOG_HREF}?${text}` : DNS_LOG_HREF;
}

/** The filter a link into the log asked for. Anything malformed in it is left at
 *  its default rather than refusing the page. */
export function filterFromQuery(query: URLSearchParams): QueryFilter {
    const field = <K extends keyof QueryFilter>(key: K, value: string | null): QueryFilter[K] => {
        if (value === null) return EMPTY_FILTER[key];
        const parsed = queryFilterSchema.shape[key].safeParse(value);
        return parsed.success ? (parsed.data as QueryFilter[K]) : EMPTY_FILTER[key];
    };
    return {
        search: field("search", query.get("domain")),
        outcome: field("outcome", query.get("outcome")),
        client: field("client", query.get("client")),
        type: field("type", query.get("type")),
        range: field("range", query.get("range")),
        page: 0
    };
}

function pauseLabel(t: Translate, seconds: number): string {
    if (seconds === 0) return t("insights.untilResumed");
    if (seconds < 60) return t("insights.seconds", { count: seconds });
    if (seconds === 3600) return t("insights.hour");
    return t("insights.minutes", { count: seconds / 60 });
}

function viaLabel(t: Translate, via: string): string {
    if (["cache", "local", "blocked", "other"].includes(via))
        return t(`insights.via.${via}` as NamespaceKey<"dnsBlocker">);
    return via;
}

export function listLabel(t: Translate, list: string): string {
    if (list === "polaris") return t("insights.ownList");
    if (list.startsWith("service-")) return serviceName(list.slice("service-".length));
    const flagged = reputationCategoryOf(list);
    if (flagged)
        return t("reputation.logLabel", { category: t(`reputation.category.${flagged}`) });
    const key = `categories.${list}` as NamespaceKey<"dnsBlocker">;
    return t.has(key) ? t(key) : list;
}

export function points(counts: readonly number[], timeline: QueryTimeline) {
    return counts.map((v, index) => ({
        t: timeline.from + index * timeline.bucketMs,
        v
    }));
}

export function DnsInsightsCard({
    mode,
    onApplied,
    onRules,
    logDays,
    refreshHours
}: {
    /** The Overview draws the numbers and sends a pick to the log; the log
     *  section draws the log and keeps its filter in the address. */
    mode: "overview" | "log";
    onApplied: () => void;
    onRules: (settings: DnsSettings) => void;
    logDays: number;
    refreshHours: number;
}) {
    const t = useTranslations("dnsBlocker");
    const router = useRouter();
    const pathname = usePathname();
    const query = useSearchParams();
    const onLog = mode === "log";
    const [filter, setFilter] = useState<QueryFilter>(() =>
        onLog && query ? filterFromQuery(new URLSearchParams(query.toString())) : EMPTY_FILTER
    );
    const [typed, setTyped] = useState(filter.search);
    const [data, setData] = useState<DnsInsights | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [pauseFor, setPauseFor] = useState("300");
    const [loading, setLoading] = useState(true);
    const [live, setLive] = useState(false);
    const [tail, setTail] = useState<QueryRow[] | null>(null);
    const [ruling, setRuling] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [applying, startApplying] = useTransition();
    const latest = useRef(0);
    // undefined while asked; null when the engine predates its metrics.
    const [metrics, setMetrics] = useState<EngineMetrics | null | undefined>(undefined);
    const [refreshingLists, startRefreshingLists] = useTransition();

    const loadMetrics = useCallback(async () => {
        const result = await dnsListsAction();
        setMetrics(result.error !== undefined ? null : result.metrics);
    }, []);

    useEffect(() => {
        if (!onLog) void loadMetrics();
    }, [onLog, loadMetrics]);

    const refreshLists = () =>
        startRefreshingLists(async () => {
            const result = await refreshDnsListsAction();
            if (result.error !== undefined) setError(result.error);
            else setNotice(t("insights.listsRefreshing"));
            await loadMetrics();
        });

    const signal = useUnmountSignal();
    const load = useCallback(async (next: QueryFilter, fresh = false) => {
        const request = ++latest.current;
        setLoading(true);
        const result = await polls.dnsInsights(next, fresh, signal());
        if (request !== latest.current) return;
        setLoading(false);
        if (result.error !== undefined) {
            setError(result.error);
            return;
        }
        setError(null);
        setData(result.insights);
    }, []);

    useEffect(() => {
        void load(filter);
    }, [filter, load]);

    useEffect(() => {
        const timer = setTimeout(() => {
            const search = typed.trim().toLowerCase();
            setFilter((current) =>
                current.search === search ? current : { ...current, search, page: 0 }
            );
        }, 300);
        return () => clearTimeout(timer);
    }, [typed]);

    // The live view: the end of today's file every few seconds, while shown.
    useEffect(() => {
        if (!live) {
            setTail(null);
            return;
        }
        let stopped = false;
        const controller = new AbortController();
        const read = async () => {
            const result = await polls.dnsTail(filter, controller.signal);
            if (stopped) return;
            if (result.error !== undefined) setError(result.error);
            else setTail(result.rows);
        };
        void read();
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void read();
        }, LIVE_EVERY_MS);
        return () => {
            stopped = true;
            controller.abort();
            clearInterval(timer);
        };
    }, [live, filter]);

    const refine = (patch: Partial<QueryFilter>) =>
        setFilter((current) => ({ ...current, page: 0, ...patch }));

    // The log keeps its filter in the address, so a reload or a shared link
    // opens the same view; replaced, not pushed, so Back leaves the log.
    useEffect(() => {
        if (!onLog) return;
        const target = logHref(filter);
        const asked = query?.toString() ?? "";
        if (target !== (asked ? `${pathname}?${asked}` : pathname))
            router.replace(target, { scroll: false });
    }, [onLog, filter, pathname, query, router]);

    /** A picked domain, device or type: the log narrows to it, and from the
     *  Overview the log opens on it. */
    const pick = (patch: Partial<QueryFilter>) => {
        if (!onLog) {
            router.push(logHref({ range: filter.range, ...patch }));
            return;
        }
        const { search, ...rest } = patch;
        if (search !== undefined) setTyped(search);
        if (Object.keys(rest).length > 0) refine(rest);
    };

    const togglePause = () =>
        startTransition(async () => {
            const result =
                data?.pause.enabled === false
                    ? await resumeDnsBlockingAction()
                    : await pauseDnsBlockingAction({ seconds: Number(pauseFor) });
            if (result.error !== undefined) setError(result.error);
            await load(filter, true);
        });

    const applySettings = () =>
        startApplying(async () => {
            const result = await turnOnDnsBlockerAction();
            if (result.error !== undefined) setError(result.error);
            onApplied();
            await load(filter, true);
        });

    const rule = (domain: string, list: "allow" | "deny") => {
        setRuling(domain);
        setNotice(null);
        void ruleFromLogAction({ domain, list }).then((result) => {
            setRuling(null);
            if (result.error !== undefined) {
                setError(result.error);
                return;
            }
            setError(null);
            setNotice(
                list === "allow"
                    ? t("insights.nowAllowed", { domain })
                    : t("insights.nowBlocked", { domain })
            );
            onRules(result.settings);
            onApplied();
        });
    };

    const stats = data?.stats;
    const pause = data?.pause;
    const pauseState = !pause
        ? null
        : pause.enabled
          ? t("insights.active")
          : pause.secondsLeft
            ? t("insights.pausedFor", { minutes: Math.ceil(pause.secondsLeft / 60) })
            : t("insights.paused");
    const ready = Boolean(data) || loading;

    return (
        <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <CardTitle className="truncate">
                        {onLog ? t("insights.log") : t("insights.title")}
                    </CardTitle>
                    {pauseState ? (
                        <Badge variant={pause?.enabled ? "success" : "warning"}>{pauseState}</Badge>
                    ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {pause?.enabled === false ? null : (
                        <Select
                            className="w-36"
                            value={pauseFor}
                            aria-label={t("insights.pauseFor")}
                            onValueChange={setPauseFor}
                            options={PAUSES.map((seconds) => ({
                                value: String(seconds),
                                label: pauseLabel(t, seconds)
                            }))}
                        />
                    )}
                    <Button variant="secondary" disabled={pending || !data} onClick={togglePause}>
                        {pending ? (
                            <Loader2 className="size-4 shrink-0 animate-spin" />
                        ) : pause?.enabled === false ? (
                            <Play className="size-4 shrink-0" />
                        ) : (
                            <Pause className="size-4 shrink-0" />
                        )}
                        {pause?.enabled === false ? t("insights.resume") : t("insights.pause")}
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("insights.refresh")}
                        title={t("insights.refresh")}
                        disabled={loading}
                        onClick={() => void load(filter, true)}
                    >
                        <RefreshCw className={`size-4 shrink-0 ${loading ? "animate-spin" : ""}`} />
                    </Button>
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-5">
                <div className="flex flex-wrap items-center gap-3">
                    <SegmentedControl<DnsRange>
                        size="sm"
                        aria-label={t("insights.range")}
                        value={filter.range}
                        onValueChange={(range) => refine({ range })}
                        options={DNS_RANGE_IDS.map((range) => ({
                            value: range,
                            label: t(`insights.ranges.${range}` as NamespaceKey<"dnsBlocker">),
                            disabled: rangeDays(range) > Math.max(1, logDays),
                            title:
                                rangeDays(range) > Math.max(1, logDays)
                                    ? t("insights.rangeKept", { days: logDays })
                                    : undefined
                        }))}
                    />
                    <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                        {t("insights.kept", { days: logDays })}
                    </p>
                </div>
                {error ? <p className="text-sm text-danger-ink">{error}</p> : null}
                {notice ? <p className="text-sm text-success-ink">{notice}</p> : null}
                {data?.logOff ? (
                    <div className="flex flex-col gap-2 rounded-md border border-warning-edge bg-warning-soft p-3 sm:flex-row sm:items-center">
                        <p className="min-w-0 flex-1 text-sm text-warning-ink">
                            {t("insights.logOff")}
                        </p>
                        <Button
                            variant="secondary"
                            className="shrink-0"
                            disabled={applying}
                            onClick={applySettings}
                        >
                            {applying ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                            {t("insights.apply")}
                        </Button>
                    </div>
                ) : null}
                {!ready || onLog ? null : (
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                        <Figure
                            label={t("insights.queries")}
                            value={stats?.queries.toLocaleString()}
                        />
                        <Figure
                            label={t("insights.blocked")}
                            value={stats?.blocked.toLocaleString()}
                        />
                        <Figure
                            label={t("insights.blockedPercent")}
                            value={stats ? `${stats.blockedPercent}%` : undefined}
                        />
                        <Figure
                            label={t("insights.listed")}
                            value={
                                metrics === undefined
                                    ? undefined
                                    : metrics
                                      ? metrics.listed.toLocaleString()
                                      : "-"
                            }
                            hint={metrics === null ? t("insights.metricsOff") : undefined}
                        />
                    </div>
                )}
                {stats && stats.queries === 0 && !data?.logOff && !onLog ? (
                    <p className="text-sm text-muted-foreground">{t("insights.empty")}</p>
                ) : null}
                {!ready || onLog ? null : (
                    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                        <ChartBlock
                            title={t("insights.overTime")}
                            series={
                                stats
                                    ? [
                                          {
                                              key: "allowed",
                                              label: t("insights.permitted"),
                                              color: ALLOWED_COLOR,
                                              points: points(stats.timeline.allowed, stats.timeline)
                                          },
                                          {
                                              key: "blocked",
                                              label: t("insights.blocked"),
                                              color: BLOCKED_COLOR,
                                              points: points(stats.timeline.blocked, stats.timeline)
                                          }
                                      ]
                                    : null
                            }
                            timeline={stats?.timeline}
                        />
                        <ChartBlock
                            title={t("insights.clientActivity")}
                            series={
                                stats
                                    ? stats.clientSeries.map((series: ClientSeries) => ({
                                          key: series.client,
                                          label: series.name || series.client,
                                          points: points(series.counts, stats.timeline)
                                      }))
                                    : null
                            }
                            timeline={stats?.timeline}
                            empty={t("insights.none")}
                        />
                    </div>
                )}
                {!ready || onLog ? null : (
                    <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                        <ShareList
                            title={t("insights.queryTypes")}
                            items={stats?.queryTypes}
                            total={stats?.queries ?? 0}
                            empty={t("insights.none")}
                            label={(name) => name}
                            hint={t("insights.filterType")}
                            onPick={(type) => pick({ type: type === "?" ? "" : type })}
                        />
                        <ShareList
                            title={t("insights.upstreams")}
                            items={stats?.destinations}
                            total={stats?.queries ?? 0}
                            empty={t("insights.none")}
                            label={(name) => viaLabel(t, name)}
                        />
                        <ShareList
                            title={t("insights.blockedBy")}
                            items={stats?.blockedBy}
                            total={stats?.blocked ?? 0}
                            empty={t("insights.none")}
                            label={(name) => listLabel(t, name)}
                            danger
                        />
                    </div>
                )}
                {!ready || onLog ? null : (
                    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                        <TopList
                            title={t("insights.topPermitted")}
                            items={stats?.topPermitted}
                            empty={t("insights.none")}
                            hint={t("insights.filterDomain")}
                            onPick={(search) => pick({ search })}
                        />
                        <TopList
                            title={t("insights.topBlocked")}
                            items={stats?.topBlocked}
                            empty={t("insights.none")}
                            hint={t("insights.filterDomain")}
                            onPick={(search) => pick({ search, outcome: "blocked" })}
                        />
                        <TopList
                            title={t("insights.topClients")}
                            items={stats?.topClients}
                            names={stats?.clients}
                            empty={t("insights.none")}
                            hint={t("insights.filterClient")}
                            onPick={(client) => pick({ client })}
                        />
                        <TopList
                            title={t("insights.topBlockedClients")}
                            items={stats?.topBlockedClients}
                            names={stats?.clients}
                            empty={t("insights.none")}
                            hint={t("insights.filterClient")}
                            onPick={(client) => pick({ client, outcome: "blocked" })}
                        />
                    </div>
                )}
                {!ready || !onLog ? null : (
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-sm font-medium">{t("insights.log")}</h3>
                            <label className="flex items-center gap-2 text-sm">
                                <Switch
                                    checked={live}
                                    onChange={setLive}
                                    aria-label={t("insights.live")}
                                />
                                <span>{t("insights.live")}</span>
                            </label>
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                            <Input
                                className="min-w-0 sm:flex-1"
                                value={typed}
                                placeholder={t("insights.search")}
                                aria-label={t("insights.search")}
                                onChange={(event) => setTyped(event.target.value)}
                            />
                            <Select
                                className="w-full sm:w-36"
                                value={filter.outcome}
                                aria-label={t("insights.outcome")}
                                onValueChange={(value) =>
                                    refine({ outcome: value as QueryFilter["outcome"] })
                                }
                                options={[
                                    { value: "all", label: t("insights.all") },
                                    { value: "blocked", label: t("insights.blockedOnly") },
                                    { value: "allowed", label: t("insights.allowedOnly") }
                                ]}
                            />
                            <Select
                                className="w-full sm:w-44"
                                value={filter.client || "*"}
                                aria-label={t("insights.client")}
                                onValueChange={(value) =>
                                    refine({ client: value === "*" ? "" : value })
                                }
                                options={[
                                    { value: "*", label: t("insights.allClients") },
                                    ...(stats?.clients ?? []).map((client) => ({
                                        value: client.address,
                                        label: client.name
                                            ? `${client.name} (${client.address})`
                                            : client.address
                                    }))
                                ]}
                            />
                            <Select
                                className="w-full sm:w-32"
                                value={filter.type || "*"}
                                aria-label={t("insights.type")}
                                onValueChange={(value) =>
                                    refine({ type: value === "*" ? "" : value })
                                }
                                options={[
                                    { value: "*", label: t("insights.allTypes") },
                                    ...(stats?.queryTypes ?? [])
                                        .filter((item) => item.name !== "?")
                                        .map((item) => ({ value: item.name, label: item.name }))
                                ]}
                            />
                        </div>
                        <QueryRows
                            rows={live ? tail : (data?.log.rows ?? null)}
                            t={t}
                            ruling={ruling}
                            onRule={rule}
                            onClient={(client) => refine({ client })}
                            onDomain={setTyped}
                        />
                        {live ? (
                            <p className="text-xs text-muted-foreground">
                                {t("insights.liveHint")}
                            </p>
                        ) : data ? (
                            <div className="flex items-center justify-between gap-2">
                                <p className="min-w-0 truncate text-xs text-muted-foreground">
                                    {t("insights.pageOf", { page: data.log.page + 1 })}
                                </p>
                                <div className="flex gap-1">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={t("insights.newer")}
                                        title={t("insights.newer")}
                                        disabled={filter.page === 0 || loading}
                                        onClick={() =>
                                            setFilter((current) => ({
                                                ...current,
                                                page: Math.max(0, current.page - 1)
                                            }))
                                        }
                                    >
                                        <ChevronLeft className="size-4 shrink-0" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={t("insights.older")}
                                        title={t("insights.older")}
                                        disabled={!data.log.hasMore || loading}
                                        onClick={() =>
                                            setFilter((current) => ({
                                                ...current,
                                                page: current.page + 1
                                            }))
                                        }
                                    >
                                        <ChevronRight className="size-4 shrink-0" />
                                    </Button>
                                </div>
                            </div>
                        ) : null}
                    </div>
                )}
                {onLog ? null : (
                    <ListsSection
                        t={t}
                        metrics={metrics}
                        refreshHours={refreshHours}
                        refreshing={refreshingLists}
                        onRefresh={refreshLists}
                    />
                )}
            </CardBody>
        </Card>
    );
}

function ListsSection({
    t,
    metrics,
    refreshHours,
    refreshing,
    onRefresh
}: {
    t: Translate;
    metrics: EngineMetrics | null | undefined;
    refreshHours: number;
    refreshing: boolean;
    onRefresh: () => void;
}) {
    return (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                    <h3 className="text-sm font-medium">{t("insights.lists")}</h3>
                    <p className="text-xs text-muted-foreground">
                        {t("insights.listsSchedule", { hours: refreshHours })}
                        {metrics?.lastRefresh
                            ? ` ${t("insights.listsLoaded", { when: new Date(metrics.lastRefresh).toLocaleString() })}`
                            : ""}
                    </p>
                </div>
                <Button variant="secondary" disabled={refreshing || !metrics} onClick={onRefresh}>
                    {refreshing ? (
                        <Loader2 className="size-4 shrink-0 animate-spin" />
                    ) : (
                        <RefreshCw className="size-4 shrink-0" />
                    )}
                    {t("insights.listsRefresh")}
                </Button>
            </div>
            {metrics === undefined ? (
                <Skeleton className="h-16 w-full" />
            ) : metrics === null ? (
                <p className="text-sm text-muted-foreground">{t("insights.metricsOff")}</p>
            ) : (
                <>
                    <ul className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                        {metrics.lists.map((list) => (
                            <li key={list.name} className="flex min-w-0 items-center gap-2 text-sm">
                                <span className="min-w-0 flex-1 truncate">
                                    {listLabel(t, list.name)}
                                </span>
                                <span className="shrink-0 tabular-nums text-muted-foreground">
                                    {t("insights.domains", { count: list.count.toLocaleString() })}
                                </span>
                            </li>
                        ))}
                    </ul>
                    {metrics.failedDownloads > 0 ? (
                        <p className="rounded-md border border-warning-edge bg-warning-soft p-2 text-xs text-warning-ink">
                            {t("insights.listsFailed", { count: metrics.failedDownloads })}
                        </p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                        {t("insights.listsPerCategory")}
                    </p>
                </>
            )}
        </div>
    );
}

export function Figure({
    label,
    value,
    hint
}: {
    label: string;
    value: string | undefined;
    hint?: string;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-1 rounded-md bg-muted p-3" title={hint}>
            <span className="truncate text-xs text-muted-foreground" title={label}>
                {label}
            </span>
            {value === undefined ? (
                <Skeleton className="h-7 w-20" />
            ) : (
                <span className="truncate text-2xl font-semibold tabular-nums" title={value}>
                    {value}
                </span>
            )}
        </div>
    );
}

export function ChartBlock({
    title,
    series,
    timeline,
    empty
}: {
    title: string;
    series: (ChartSeries & { color?: string })[] | null;
    timeline: QueryTimeline | undefined;
    empty?: string;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <h3 className="truncate text-sm font-medium" title={title}>
                    {title}
                </h3>
                {series && series.length > 0 ? (
                    <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {series.map((line, index) => (
                            <li key={line.key} className="flex min-w-0 items-center gap-1.5">
                                <span
                                    className="size-2 shrink-0 rounded-full"
                                    style={{
                                        background:
                                            line.color ??
                                            SERIES_COLORS[index % SERIES_COLORS.length]
                                    }}
                                />
                                <span className="max-w-[12rem] truncate" title={line.label}>
                                    {line.label}
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
            {!series || !timeline ? (
                <Skeleton className="h-[132px] w-full" />
            ) : series.length === 0 && empty ? (
                <p className="text-sm text-muted-foreground">{empty}</p>
            ) : (
                <MultiSeriesChart
                    label={title}
                    series={series}
                    from={timeline.from}
                    to={timeline.from + (timeline.allowed.length - 1) * timeline.bucketMs}
                />
            )}
        </div>
    );
}

export function ShareList({
    title,
    items,
    total,
    empty,
    label,
    hint,
    onPick,
    danger = false
}: {
    title: string;
    items: readonly NameCount[] | undefined;
    total: number;
    empty: string;
    label: (name: string) => string;
    hint?: string;
    onPick?: (name: string) => void;
    danger?: boolean;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-sm font-medium">{title}</h3>
            {!items ? (
                <Skeleton className="h-24 w-full" />
            ) : items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{empty}</p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {items.map((item) => {
                        const share = total > 0 ? (item.count / total) * 100 : 0;
                        const name = label(item.name);
                        return (
                            <li key={item.name} className="flex min-w-0 flex-col gap-1 text-sm">
                                <div className="flex min-w-0 items-center gap-2">
                                    {onPick ? (
                                        <button
                                            type="button"
                                            title={hint}
                                            className="min-w-0 flex-1 break-all text-left hover:underline"
                                            onClick={() => onPick(item.name)}
                                        >
                                            {name}
                                        </button>
                                    ) : (
                                        <span className="min-w-0 flex-1 break-all" title={name}>
                                            {name}
                                        </span>
                                    )}
                                    <span className="shrink-0 tabular-nums text-muted-foreground">
                                        {share < 0.1 && share > 0 ? "<0.1" : share.toFixed(1)}%
                                    </span>
                                </div>
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                    <div
                                        className={`h-full rounded-full ${danger ? "bg-danger" : "bg-primary"}`}
                                        style={{ width: `${Math.max(share, 1)}%` }}
                                    />
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

export function TopList({
    title,
    items,
    names,
    empty,
    hint,
    onPick
}: {
    title: string;
    items: readonly NameCount[] | undefined;
    names?: readonly { address: string; name: string }[];
    empty: string;
    hint: string;
    onPick: (name: string) => void;
}) {
    const nameOf = (address: string) =>
        names?.find((client) => client.address === address)?.name ?? "";
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-sm font-medium">{title}</h3>
            {!items ? (
                <Skeleton className="h-24 w-full" />
            ) : items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{empty}</p>
            ) : (
                <ul className="flex flex-col gap-1">
                    {items.map((item) => {
                        const name = nameOf(item.name);
                        const shown = name ? `${name} (${item.name})` : item.name;
                        return (
                            <li key={item.name} className="flex min-w-0 items-center gap-2 text-sm">
                                <button
                                    type="button"
                                    title={`${shown} - ${hint}`}
                                    className="min-w-0 flex-1 break-all text-left hover:underline"
                                    onClick={() => onPick(item.name)}
                                >
                                    {shown}
                                </button>
                                <span className="shrink-0 tabular-nums text-muted-foreground">
                                    {item.count.toLocaleString()}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

/** A row's time: the clock alone for today's rows, with the date otherwise. */
export function rowTime(at: number, now: Date = new Date()): string {
    const when = new Date(at);
    return when.toDateString() === now.toDateString()
        ? when.toLocaleTimeString()
        : when.toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit"
          });
}

function QueryRows({
    rows,
    t,
    ruling,
    onRule,
    onClient,
    onDomain
}: {
    rows: readonly QueryRow[] | null;
    t: Translate;
    ruling: string | null;
    onRule: (domain: string, list: "allow" | "deny") => void;
    onClient: (client: string) => void;
    onDomain: (domain: string) => void;
}) {
    if (!rows) return <Skeleton className="h-40 w-full" />;
    if (rows.length === 0)
        return <p className="text-sm text-muted-foreground">{t("insights.noMatches")}</p>;
    return (
        <div className="max-h-[28rem] overflow-auto overscroll-contain rounded-md border border-border">
            <table className="w-full table-fixed text-sm">
                <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                    <tr>
                        <th className="w-20 p-2 pl-3 font-medium sm:w-32">{t("insights.time")}</th>
                        <th className="p-2 font-medium">{t("insights.domain")}</th>
                        <th className="hidden w-14 p-2 font-medium sm:table-cell">
                            {t("insights.type")}
                        </th>
                        <th className="hidden w-32 p-2 font-medium md:table-cell xl:w-40">
                            {t("insights.client")}
                        </th>
                        <th className="hidden w-32 p-2 font-medium lg:table-cell xl:w-40">
                            {t("insights.answeredBy")}
                        </th>
                        <th className="w-12 p-2">
                            <span className="sr-only">{t("insights.actions")}</span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, index) => {
                        const at = Number.isNaN(row.at) ? row.time : rowTime(row.at);
                        const full = Number.isNaN(row.at)
                            ? row.time
                            : new Date(row.at).toLocaleString();
                        const blocked = row.outcome === "blocked";
                        const outcome = blocked
                            ? t("insights.blockedOnly")
                            : t("insights.allowedOnly");
                        const action = blocked ? t("insights.allowName") : t("insights.blockName");
                        return (
                            <tr
                                key={`${row.time}-${row.domain}-${index}`}
                                className="border-t border-border"
                            >
                                <td
                                    className="relative break-words p-2 pl-3 align-top tabular-nums text-muted-foreground"
                                    title={`${full} - ${outcome}`}
                                >
                                    <span
                                        aria-hidden
                                        data-outcome={row.outcome}
                                        className={`absolute inset-y-0 left-0 w-1 ${blocked ? "bg-danger" : "bg-success"}`}
                                    />
                                    {at}
                                </td>
                                <td className="p-2 align-top">
                                    <button
                                        type="button"
                                        title={`${row.domain} - ${outcome}`}
                                        className={`block w-full break-all text-left hover:underline ${blocked ? "text-danger-ink line-through" : ""}`}
                                        onClick={() => onDomain(row.domain)}
                                    >
                                        <span className="sr-only">{outcome}: </span>
                                        {row.domain}
                                    </button>
                                </td>
                                <td
                                    className="hidden truncate p-2 align-top text-muted-foreground sm:table-cell"
                                    title={row.type}
                                >
                                    {row.type}
                                </td>
                                <td className="hidden p-2 align-top md:table-cell">
                                    <button
                                        type="button"
                                        title={`${row.clientName ? `${row.clientName} (${row.client})` : row.client} - ${t("insights.filterClient")}`}
                                        className="block w-full truncate text-left hover:underline"
                                        onClick={() => onClient(row.client)}
                                    >
                                        {row.clientName || row.client}
                                    </button>
                                </td>
                                <td
                                    className="hidden truncate p-2 align-top text-muted-foreground lg:table-cell"
                                    title={row.reason}
                                >
                                    {blocked && row.list
                                        ? listLabel(t, row.list)
                                        : row.via === "blocked"
                                          ? row.reason
                                          : row.via === "cache" ||
                                              row.via === "local" ||
                                              row.via === "other"
                                            ? t(
                                                  `insights.via.${row.via}` as NamespaceKey<"dnsBlocker">
                                              )
                                            : row.via}
                                </td>
                                <td className="p-1 text-right align-top">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`${action}: ${row.domain}`}
                                        title={action}
                                        disabled={ruling !== null}
                                        onClick={() =>
                                            onRule(row.domain, blocked ? "allow" : "deny")
                                        }
                                    >
                                        {ruling === row.domain ? (
                                            <Loader2 className="size-4 shrink-0 animate-spin" />
                                        ) : blocked ? (
                                            <ShieldCheck className="size-4 shrink-0" />
                                        ) : (
                                            <Ban className="size-4 shrink-0" />
                                        )}
                                    </Button>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
