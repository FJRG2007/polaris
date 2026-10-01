"use client";

/**
 * Watch > Connectivity: how often this deployment lost its connection, and for
 * how long.
 *
 * The chrome paints at once - title, section headings, filters, column headers -
 * and only the figures wait for `/api/watch/connectivity`. A revisit paints the
 * last answer from the session cache while the fresh one is on its way, and the
 * read is polled while the screen is open so the state at the top stays live.
 *
 * Every figure here comes from the outage record the address watcher keeps
 * (`lib/connectivity`); nothing on this screen probes anything except "Check
 * now", which runs the watcher's own pass early.
 */

import { RefreshCw } from "lucide-react";
import { OutageTable } from "./outage-table";
import { MergeGapForm } from "./merge-gap-form";
import * as rules from "@/lib/connectivity/outages";
import { checkConnectivityAction } from "./actions";
import { DowntimeHeatmap } from "./downtime-heatmap";
import * as list from "@/lib/connectivity/outage-list";
import { RelativeTime } from "@/components/relative-time";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useDisplayFormat } from "@/components/display-format";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type { ConnectivityReport, OutageView } from "@/lib/connectivity/outage-tracker";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, PageHeader, Skeleton } from "@polaris/ui";

/** The watcher looks every half-minute while something is down, so asking more
 *  often than that would redraw the same answer. */
const POLL_MS = 30_000;
const HEATMAP_DAYS = 90;

type Words = NamespaceTranslator<"watch">;

/** A length of time in this screen's words. */
export function spanWith(t: Words): (ms: number) => string {
    return (ms) => rules.formatSpan(ms, (form, values) => t(`span.${form}`, values));
}

export function kindLabel(t: Words, kind: rules.OutageKind): string {
    return t(`connectivity.kinds.${kind}`);
}

/** Uptime as a share, never rounded up to a perfect score it did not earn. */
function uptimeText(uptime: number | null, format: ReturnType<typeof useDisplayFormat>): string | null {
    if (uptime === null) return null;
    const floored = Math.floor(uptime * 10_000) / 100;
    return `${format.number(floored, { minimumFractionDigits: floored === 100 ? 0 : 2, maximumFractionDigits: 2 })}%`;
}

export function ConnectivityView() {
    const t = useTranslations("watch");
    const format = useDisplayFormat();
    const span = useMemo(() => spanWith(t), [t]);
    const { data, loading, error, refresh, replace } = useLiveResource<ConnectivityReport>({
        url: "/api/watch/connectivity",
        cacheKey: "watch.connectivity",
        intervalMs: POLL_MS,
        select: (body) => body as ConnectivityReport
    });

    // The clock the durations are measured against, ticking so an ongoing outage
    // counts up between polls rather than in thirty-second jumps.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 5000);
        return () => clearInterval(timer);
    }, []);

    const [checking, startCheck] = useTransition();
    const [checkError, setCheckError] = useState<string | null>(null);
    const checkNow = () => {
        if (checking) return;
        startCheck(async () => {
            setCheckError(null);
            const result = await checkConnectivityAction();
            if (result.error) setCheckError(result.error);
            refresh();
        });
    };

    const staleMs = data?.staleAfterMs ?? 0;
    const spans = useMemo(
        () =>
            (data?.outages ?? []).map((outage) => ({
                startedAt: Date.parse(outage.startedAt),
                endedAt: outage.endedAt === null ? null : Date.parse(outage.endedAt),
                lastSeenAt: Date.parse(outage.lastSeenAt)
            })),
        [data?.outages]
    );
    const days = useMemo(
        () =>
            data
                ? rules.dailyDowntime(spans, now, HEATMAP_DAYS, staleMs, format.preferences.timeZone)
                : null,
        // Re-cut once a minute, not on every five-second tick.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [data, spans, Math.floor(now / 60_000), staleMs, format.preferences.timeZone]
    );

    const filters = useFilters(days);
    const since = data?.since ? Date.parse(data.since) : null;

    return (
        <>
            <PageHeader
                title={t("connectivity.title")}
                description={t("connectivity.description")}
                actions={
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={checkNow}
                        aria-disabled={checking}
                        title={t("connectivity.checkNow")}
                        aria-label={t("connectivity.checkNow")}
                    >
                        <RefreshCw className={checking ? "animate-spin" : undefined} aria-hidden="true" />
                        <span className="hidden sm:inline">
                            {checking ? t("connectivity.checking") : t("connectivity.checkNow")}
                        </span>
                    </Button>
                }
            />
            {checkError ? <p className="mb-3 text-sm text-danger">{checkError}</p> : null}

            {error && !data ? (
                <EmptyState title={t("connectivity.errors.load")} description={t("connectivity.errors.loadHint")} />
            ) : (
                <div className="flex flex-col gap-5">
                    <CurrentState report={data} now={now} span={span} />

                    <section className="flex flex-col gap-3" aria-labelledby="connectivity-periods">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <h2 id="connectivity-periods" className="text-sm font-medium">
                                {t("connectivity.periods.title")}
                            </h2>
                            {since !== null ? (
                                <span className="text-xs text-muted-foreground">
                                    {t("connectivity.periods.since", { date: format.date(since) })}
                                </span>
                            ) : null}
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            {(["24h", "7d", "30d", "90d"] as const).map((key) => (
                                <PeriodTile
                                    key={key}
                                    title={t(`connectivity.periods.${key}`)}
                                    summary={data?.periods.find((period) => period.key === key) ?? null}
                                    loading={loading && !data}
                                    span={span}
                                    uptime={(value) => uptimeText(value, format)}
                                />
                            ))}
                        </div>
                    </section>

                    <Card>
                        <CardHeader>
                            <CardTitle>{t("connectivity.days.title")}</CardTitle>
                            <p className="text-xs text-muted-foreground">{t("connectivity.days.description")}</p>
                        </CardHeader>
                        <CardBody className="overflow-x-auto">
                            <DowntimeHeatmap
                                days={days}
                                since={since}
                                selected={filters.value.day?.label ?? null}
                                onSelect={(day) =>
                                    filters.set({
                                        ...filters.value,
                                        day: day ? { label: day.day, start: day.start, end: day.end } : null
                                    })
                                }
                                span={span}
                            />
                        </CardBody>
                    </Card>

                    <OutageTable
                        outages={data?.outages ?? null}
                        truncated={data?.truncated ?? false}
                        filters={filters.value}
                        onFilters={filters.set}
                        now={now}
                        staleMs={staleMs}
                        span={span}
                    />

                    {data && data.months.length > 0 ? <OlderMonths report={data} span={span} /> : null}

                    <MergeGapForm
                        seconds={data?.mergeGapSeconds ?? null}
                        onSaved={(seconds) => {
                            if (data) replace({ ...data, mergeGapSeconds: seconds });
                        }}
                    />
                </div>
            )}
        </>
    );
}

/**
 * The list's filters, kept in the address bar so a filtered view survives a
 * reload and can be shared. A picked day is placed against the heatmap's own days,
 * so it is cut in the same time zone the grid is.
 */
function useFilters(days: readonly rules.DayDowntime[] | null) {
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const value = useMemo(
        () =>
            list.filtersFromQuery(
                (key) => params.get(key),
                (label) => {
                    const day = days?.find((entry) => entry.day === label);
                    return day ? { start: day.start, end: day.end } : null;
                }
            ),
        [params, days]
    );
    const set = useCallback(
        (next: list.OutageFilters) => {
            const query = new URLSearchParams(list.filtersToQuery(next)).toString();
            router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
        },
        [router, pathname]
    );
    return { value, set };
}

function CurrentState({
    report,
    now,
    span
}: {
    report: ConnectivityReport | null;
    now: number;
    span: (ms: number) => string;
}) {
    const t = useTranslations("watch");
    const format = useDisplayFormat();

    if (!report) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                        {t("connectivity.state.title")}
                    </span>
                    <Skeleton className="h-5 w-40" />
                    <Skeleton className="h-4 w-72 max-w-full" />
                </CardBody>
            </Card>
        );
    }

    const open = report.open;
    const lastPass = report.lastPass;
    const unwatched = lastPass !== null && now - Date.parse(lastPass.at) > report.staleAfterMs;
    const state: "online" | "offline" | "unknown" =
        lastPass === null ? "unknown" : open ? "offline" : lastPass.up ? "online" : "unknown";
    const cadence =
        report.mergeGapSeconds > 0
            ? t("connectivity.state.cadence", {
                  interval: span(report.watchIntervalMs),
                  close: span(report.closeWatchMs),
                  gap: span(report.mergeGapSeconds * 1000)
              })
            : t("connectivity.state.cadenceNoMerge", {
                  interval: span(report.watchIntervalMs),
                  close: span(report.closeWatchMs)
              });

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    {t("connectivity.state.title")}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={state === "online" ? "success" : state === "offline" ? "danger" : "neutral"}>
                        {t(`connectivity.state.${state}`)}
                    </Badge>
                    {open ? <Badge>{kindLabel(t, open.kind)}</Badge> : null}
                </div>
                <div className="flex flex-col gap-1 text-[0.8125rem] text-muted-foreground">
                    {open ? (
                        <OpenOutage outage={open} now={now} staleMs={report.staleAfterMs} span={span} />
                    ) : lastPass === null ? (
                        <p>{t("connectivity.state.never")}</p>
                    ) : (
                        <p>
                            {t.rich("connectivity.state.onlineBody", {
                                time: () => <RelativeTime key="checked" iso={lastPass.at} />
                            })}
                        </p>
                    )}
                    {unwatched && lastPass ? (
                        <p className="text-warning-ink">
                            {t("connectivity.state.unwatched", { time: format.dateTime(lastPass.at) })}
                        </p>
                    ) : null}
                    <p className="text-xs text-foreground-subtle">{cadence}</p>
                </div>
            </CardBody>
        </Card>
    );
}

function OpenOutage({
    outage,
    now,
    staleMs,
    span
}: {
    outage: OutageView;
    now: number;
    staleMs: number;
    span: (ms: number) => string;
}) {
    const t = useTranslations("watch");
    const format = useDisplayFormat();
    const length = list.outageLength(outage, now, staleMs);
    return (
        <>
            <p className="text-foreground tabular">
                {t("connectivity.state.offlineBody", {
                    duration: span(length),
                    since: format.dateTime(outage.startedAt)
                })}
            </p>
            <p>{t(`connectivity.kindHints.${outage.kind}`)}</p>
            {outage.detectedBy ? (
                <p className="break-words [overflow-wrap:anywhere]">
                    {outage.detail
                        ? t("connectivity.state.detected", { host: outage.detectedBy, detail: outage.detail })
                        : t("connectivity.state.detectedHost", { host: outage.detectedBy })}
                </p>
            ) : null}
            {outage.firstBack === rules.BACK_VIA_INTERNET && outage.firstBackAt ? (
                <p>{t("connectivity.state.lineBack", { time: format.time(outage.firstBackAt) })}</p>
            ) : null}
        </>
    );
}

function PeriodTile({
    title,
    summary,
    loading,
    span,
    uptime
}: {
    title: string;
    summary: rules.PeriodSummary | null;
    loading: boolean;
    span: (ms: number) => string;
    uptime: (value: number | null) => string | null;
}) {
    const t = useTranslations("watch");
    const share = summary ? uptime(summary.uptime) : null;
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-0.5">
                    <span className="text-xs text-muted-foreground">{title}</span>
                    {loading ? (
                        <Skeleton className="h-7 w-24" />
                    ) : (
                        <span className="text-2xl font-semibold tracking-tight tabular">
                            {share ?? t("connectivity.periods.noData")}
                        </span>
                    )}
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                    <Figure label={t("connectivity.periods.outages")} loading={loading}>
                        {summary ? String(summary.count) : "-"}
                    </Figure>
                    <Figure label={t("connectivity.periods.down")} loading={loading}>
                        {summary && summary.count > 0 ? span(summary.downMs) : "-"}
                    </Figure>
                    <Figure label={t("connectivity.periods.longest")} loading={loading}>
                        {summary && summary.count > 0 ? span(summary.longestMs) : "-"}
                    </Figure>
                    <Figure label={t("connectivity.periods.average")} loading={loading}>
                        {summary && summary.count > 0 ? span(summary.averageMs) : "-"}
                    </Figure>
                </dl>
            </CardBody>
        </Card>
    );
}

function Figure({ label, loading, children }: { label: string; loading: boolean; children: React.ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col">
            <dt className="truncate text-foreground-subtle" title={label}>
                {label}
            </dt>
            <dd className="truncate font-medium text-foreground tabular">
                {loading ? <Skeleton className="mt-0.5 h-4 w-12" /> : children}
            </dd>
        </div>
    );
}

function OlderMonths({ report, span }: { report: ConnectivityReport; span: (ms: number) => string }) {
    const t = useTranslations("watch");
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("connectivity.older.title")}</CardTitle>
                <p className="text-xs text-muted-foreground">{t("connectivity.older.description")}</p>
            </CardHeader>
            <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-[0.8125rem]">
                    <thead>
                        <tr className="border-b border-border text-left">
                            <th className="px-4 py-2">{t("connectivity.older.month")}</th>
                            <th className="px-4 py-2">{t("connectivity.list.kind")}</th>
                            <th className="px-4 py-2 text-right">{t("connectivity.periods.outages")}</th>
                            <th className="px-4 py-2 text-right">{t("connectivity.periods.down")}</th>
                            <th className="px-4 py-2 text-right">{t("connectivity.periods.longest")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {report.months.map((month) => (
                            <tr key={`${month.month}-${month.kind}`} className="border-b border-border last:border-0">
                                <td className="px-4 py-2 tabular">{month.month}</td>
                                <td className="px-4 py-2">{kindLabel(t, month.kind)}</td>
                                <td className="px-4 py-2 text-right tabular">{month.count}</td>
                                <td className="px-4 py-2 text-right tabular">{span(month.downtimeSeconds * 1000)}</td>
                                <td className="px-4 py-2 text-right tabular">{span(month.longestSeconds * 1000)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </Card>
    );
}
