"use client";

/**
 * The top of Polar's Usage page: what this person spent over a period, per
 * day, per model and per chat, laid out as the provider consoles lay theirs
 * (a daily chart over a period, then the period split by model).
 *
 * The heading and the period picker paint at once; only the figures wait,
 * behind skeletons shaped like them. The last report seen for a period is kept
 * for the tab, so going back to it shows it at once and refreshes underneath.
 */

import Link from "next/link";
import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IntegrationLogo } from "@/components/logos";
import { modelLabel } from "@/components/polar/routing-editor";
import { formatTokens, formatUsd } from "@/lib/polar/usage-format";
import { Badge, Button, SegmentedControl, Skeleton, cn, settingType } from "@polaris/ui";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import type { ModelSelectorProvider } from "@/components/polar/elements/model-selector";
import {
    POLAR_USAGE_RANGES,
    type PolarUsageRange,
    type PolarUsageReport
} from "@/lib/polar/usage-report";
import { loadUsageReportAction } from "./routing-actions";

type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; report: PolarUsageReport };

const CACHE_PREFIX = "polaris.polar-usage-report.";

function cached(range: PolarUsageRange): PolarUsageReport | null {
    try {
        const raw = sessionStorage.getItem(`${CACHE_PREFIX}${range}`);
        return raw ? (JSON.parse(raw) as PolarUsageReport) : null;
    } catch {
        return null;
    }
}

function remember(range: PolarUsageRange, report: PolarUsageReport) {
    try {
        sessionStorage.setItem(`${CACHE_PREFIX}${range}`, JSON.stringify(report));
    } catch {
        // Storage refused (private window, quota): the next visit loads again.
    }
}

export function UsageReportCard({ providers }: { providers: ModelSelectorProvider[] | null }) {
    const t = useTranslations("polar");
    const [range, setRange] = useState<PolarUsageRange>("30d");
    const [load, setLoad] = useState<Load>({ state: "loading" });
    const [attempt, setAttempt] = useState(0);
    const latest = useRef(0);

    useEffect(() => {
        const request = ++latest.current;
        const known = cached(range);
        setLoad(known ? { state: "ready", report: known } : { state: "loading" });
        void loadUsageReportAction(range)
            .then((result) => {
                if (request !== latest.current) return;
                if (result.report) {
                    remember(range, result.report);
                    setLoad({ state: "ready", report: result.report });
                } else if (!known) setLoad({ state: "failed" });
            })
            .catch(() => {
                if (request === latest.current && !known) setLoad({ state: "failed" });
            });
    }, [range, attempt]);

    return (
        <section className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="text-sm font-medium text-foreground">{t("usageReport.title")}</h2>
                    <p className={settingType.hint}>{t("usageReport.intro")}</p>
                </div>
                <SegmentedControl
                    aria-label={t("usageReport.range")}
                    value={range}
                    onValueChange={setRange}
                    options={POLAR_USAGE_RANGES.map((value) => ({
                        value,
                        label: t(`usageReport.ranges.${value}` as const)
                    }))}
                />
            </div>
            <UsageReportData
                load={load}
                providers={providers}
                onRetry={() => setAttempt((count) => count + 1)}
            />
        </section>
    );
}

/** The figures: skeletons while they load, a retry when they failed, the report when they came. */
export function UsageReportData({
    load,
    providers,
    onRetry
}: {
    load: Load;
    providers: ModelSelectorProvider[] | null;
    onRetry: () => void;
}) {
    const t = useTranslations("polar");
    if (load.state === "loading") {
        return (
            <div className="flex flex-col gap-4" aria-busy="true">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    {Array.from({ length: 5 }, (_, index) => (
                        <div key={index} className="flex flex-col gap-2 rounded-md border border-border p-3">
                            <Skeleton className="h-3 w-16" />
                            <Skeleton className="h-5 w-12" />
                        </div>
                    ))}
                </div>
                <Skeleton className="h-36 w-full rounded-md" />
                <Skeleton className="h-32 w-full rounded-md" />
            </div>
        );
    }
    if (load.state === "failed") {
        return (
            <div
                role="alert"
                className="flex flex-col items-center gap-3 rounded-md border border-border px-4 py-8 text-center"
            >
                <p className={settingType.error}>{t("usageReport.failed")}</p>
                <Button size="sm" variant="outline" onClick={onRetry}>
                    <RotateCw className="size-4 shrink-0" />
                    {t("usageReport.retry")}
                </Button>
            </div>
        );
    }
    if (load.report.totals.answers === 0) {
        return (
            <p className={cn(settingType.body, "rounded-md border border-border px-4 py-8 text-center text-muted-foreground")}>
                {t("usageReport.empty")}
            </p>
        );
    }
    return <Report report={load.report} providers={providers} />;
}

function Report({
    report,
    providers
}: {
    report: PolarUsageReport;
    providers: ModelSelectorProvider[] | null;
}) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const tokens = (count: number) => formatTokens(count, locale);
    const { totals } = report;
    const tiles = [
        { label: t("usageReport.answers"), value: totals.answers.toLocaleString(locale) },
        { label: t("usageReport.input"), value: tokens(totals.inputTokens) },
        { label: t("usageReport.output"), value: tokens(totals.outputTokens) },
        { label: t("usageReport.cached"), value: tokens(totals.cachedTokens) },
        { label: t("usageReport.cost"), value: formatUsd(totals.costUsd, locale) }
    ];
    return (
        <div className="flex min-w-0 flex-col gap-4">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {tiles.map((tile) => (
                    <div key={tile.label} className="min-w-0 rounded-md border border-border p-3">
                        <dt className={cn(settingType.hint, "truncate")} title={tile.label}>
                            {tile.label}
                        </dt>
                        <dd className="truncate text-base font-semibold tabular-nums" title={tile.value}>
                            {tile.value}
                        </dd>
                    </div>
                ))}
            </dl>
            {totals.unpriced > 0 ? (
                <p className={settingType.hint}>
                    {t("usageReport.unpriced", { count: totals.unpriced })}
                </p>
            ) : null}
            <TokensChart report={report} />
            <ModelsTable report={report} providers={providers} />
            <LatencyTable report={report} providers={providers} />
            <ChatsTable report={report} />
        </div>
    );
}

const CHART_HEIGHT = 120;
/** The surface gap between the two stacked segments, in chart units. */
const SEGMENT_GAP = 2;

/**
 * Tokens per day as stacked bars: input at the base in the primary tone,
 * output above it in a lighter step of the same hue, a surface gap between.
 * Inline SVG like the API usage chart; each day names its own figures on hover.
 */
function TokensChart({ report }: { report: PolarUsageReport }) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const peak = Math.max(...report.days.map((day) => day.inputTokens + day.outputTokens), 1);
    const day = (time: number) =>
        new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(time);
    const first = report.days[0];
    const last = report.days[report.days.length - 1];
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-medium text-foreground">{t("usageReport.perDay")}</h3>
                <span className={cn(settingType.hint, "flex items-center gap-3")}>
                    <span className="inline-flex items-center gap-1">
                        <span className="size-2 rounded-sm bg-primary" aria-hidden="true" />
                        {t("usageReport.input")}
                    </span>
                    <span className="inline-flex items-center gap-1">
                        <span className="size-2 rounded-sm bg-primary/40" aria-hidden="true" />
                        {t("usageReport.output")}
                    </span>
                </span>
            </div>
            <div className="rounded-md border border-border p-3">
                <svg
                    viewBox={`0 0 ${report.days.length * 10} ${CHART_HEIGHT}`}
                    preserveAspectRatio="none"
                    className="block h-32 w-full"
                    role="img"
                    aria-label={t("usageReport.chartLabel", {
                        input: formatTokens(report.totals.inputTokens, locale),
                        output: formatTokens(report.totals.outputTokens, locale)
                    })}
                >
                    {report.days.map((point, index) => {
                        const input = (point.inputTokens / peak) * CHART_HEIGHT;
                        const output = (point.outputTokens / peak) * CHART_HEIGHT;
                        const x = index * 10;
                        return (
                            <g key={point.t}>
                                <title>
                                    {t("usageReport.dayTip", {
                                        day: day(point.t),
                                        answers: point.answers.toLocaleString(locale),
                                        input: formatTokens(point.inputTokens, locale),
                                        output: formatTokens(point.outputTokens, locale),
                                        cost: formatUsd(point.costUsd, locale)
                                    })}
                                </title>
                                {/* The full column is the hover target, so a quiet day still says it was quiet. */}
                                <rect x={x} y={0} width={10} height={CHART_HEIGHT} fill="transparent" />
                                {input > 0 ? (
                                    <rect
                                        x={x + 1}
                                        y={CHART_HEIGHT - input}
                                        width={8}
                                        height={input}
                                        className="fill-primary"
                                    />
                                ) : null}
                                {output > SEGMENT_GAP ? (
                                    <rect
                                        x={x + 1}
                                        y={CHART_HEIGHT - input - output}
                                        width={8}
                                        height={output - (input > 0 ? SEGMENT_GAP : 0)}
                                        className="fill-primary/40"
                                    />
                                ) : null}
                            </g>
                        );
                    })}
                </svg>
                {first && last ? (
                    <div className={cn(settingType.hint, "mt-1 flex justify-between gap-2")}>
                        <span className="truncate">{day(first.t)}</span>
                        <span className="truncate">{day(last.t)}</span>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

const TH = "whitespace-nowrap px-3 py-2 text-end font-medium";
const TD = "whitespace-nowrap px-3 py-2 text-end tabular-nums";

function ModelsTable({
    report,
    providers
}: {
    report: PolarUsageReport;
    providers: ModelSelectorProvider[] | null;
}) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const tokens = (count: number) => formatTokens(count, locale);
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-xs font-medium text-foreground">{t("usageReport.byModel")}</h3>
            <div className="overflow-x-auto rounded-md border border-border">
                <table className={cn(settingType.body, "w-full min-w-[36rem]")}>
                    <thead className="bg-surface/60 text-start">
                        <tr>
                            <th className="w-full max-w-0 px-3 py-2 font-medium">{t("usageReport.model")}</th>
                            <th className={TH}>{t("usageReport.answers")}</th>
                            <th className={TH}>{t("usageReport.input")}</th>
                            <th className={TH}>{t("usageReport.output")}</th>
                            <th className={TH}>{t("usageReport.cached")}</th>
                            <th className={TH}>{t("usageReport.cost")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {report.models.map((row) => {
                            const name = modelLabel({ provider: row.provider, model: row.model }, providers).label;
                            const payer =
                                row.payer === "instance"
                                    ? t("routing.usage.unitemized.instance")
                                    : t("routing.usage.unitemized.own");
                            return (
                                <tr key={`${row.provider}/${row.model}/${row.payer}`} className="border-t border-border">
                                    <td className="w-full max-w-0 px-3 py-2">
                                        <span className="flex min-w-0 items-center gap-2">
                                            <IntegrationLogo slug={row.provider} className="size-4 shrink-0" />
                                            <span className="min-w-0 truncate" title={`${row.provider}/${row.model}`}>
                                                {name}
                                            </span>
                                            <Badge variant="neutral" className="shrink-0">
                                                {payer}
                                            </Badge>
                                        </span>
                                    </td>
                                    <td className={TD}>{row.answers.toLocaleString(locale)}</td>
                                    <td className={TD}>{tokens(row.inputTokens)}</td>
                                    <td className={TD}>{tokens(row.outputTokens)}</td>
                                    <td className={cn(TD, "text-muted-foreground")}>{tokens(row.cachedTokens)}</td>
                                    <td
                                        className={TD}
                                        title={
                                            row.unpriced > 0
                                                ? t("usageReport.unpriced", { count: row.unpriced })
                                                : undefined
                                        }
                                    >
                                        {row.unpriced === row.answers ? "-" : formatUsd(row.costUsd, locale)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/** A response time as read: milliseconds under a second, seconds past it. */
function duration(ms: number | null, locale: string, t: NamespaceTranslator<"polar">): string {
    if (ms === null) return "-";
    if (ms < 1000) return t("usageReport.ms", { ms: ms.toLocaleString(locale) });
    return t("usageReport.seconds", {
        seconds: (ms / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })
    });
}

/**
 * How fast each model answered: time to the first token and to the end, p50
 * and p95, over the answers that were timed. Answers from before timing are
 * left out and said to be, never read as instant.
 */
function LatencyTable({
    report,
    providers
}: {
    report: PolarUsageReport;
    providers: ModelSelectorProvider[] | null;
}) {
    const t = useTranslations("polar");
    const locale = useLocale();
    // A report kept from before answers were timed has no list.
    const rows = report.latency ?? [];
    const timed = rows.reduce((sum, row) => sum + row.timed, 0);
    const untimed = Math.max(0, report.totals.answers - timed);
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-xs font-medium text-foreground">{t("usageReport.latency")}</h3>
            {rows.length === 0 ? (
                <p className={settingType.hint}>{t("usageReport.latencyEmpty")}</p>
            ) : (
                <div className="overflow-x-auto rounded-md border border-border">
                    <table className={cn(settingType.body, "w-full min-w-[36rem]")}>
                        <thead className="bg-surface/60 text-start">
                            <tr>
                                <th className="w-full max-w-0 px-3 py-2 font-medium">{t("usageReport.model")}</th>
                                <th className={TH}>{t("usageReport.timed")}</th>
                                <th className={TH}>{t("usageReport.firstTokenP50")}</th>
                                <th className={TH}>{t("usageReport.firstTokenP95")}</th>
                                <th className={TH}>{t("usageReport.answerP50")}</th>
                                <th className={TH}>{t("usageReport.answerP95")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => {
                                const name = modelLabel({ provider: row.provider, model: row.model }, providers).label;
                                return (
                                    <tr key={`${row.provider}/${row.model}`} className="border-t border-border">
                                        <td className="w-full max-w-0 px-3 py-2">
                                            <span className="flex min-w-0 items-center gap-2">
                                                <IntegrationLogo slug={row.provider} className="size-4 shrink-0" />
                                                <span className="min-w-0 truncate" title={`${row.provider}/${row.model}`}>
                                                    {name}
                                                </span>
                                            </span>
                                        </td>
                                        <td className={cn(TD, "text-muted-foreground")}>{row.timed.toLocaleString(locale)}</td>
                                        <td className={TD}>{duration(row.firstTokenP50, locale, t)}</td>
                                        <td className={cn(TD, "text-muted-foreground")}>{duration(row.firstTokenP95, locale, t)}</td>
                                        <td className={TD}>{duration(row.answerP50, locale, t)}</td>
                                        <td className={cn(TD, "text-muted-foreground")}>{duration(row.answerP95, locale, t)}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            {untimed > 0 ? (
                <p className={settingType.hint}>{t("usageReport.untimed", { count: untimed })}</p>
            ) : null}
        </div>
    );
}

function ChatsTable({ report }: { report: PolarUsageReport }) {
    const t = useTranslations("polar");
    const locale = useLocale();
    if (report.chats.length === 0) return null;
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-xs font-medium text-foreground">{t("usageReport.byChat")}</h3>
            <div className="overflow-x-auto rounded-md border border-border">
                <table className={cn(settingType.body, "w-full min-w-[28rem]")}>
                    <thead className="bg-surface/60 text-start">
                        <tr>
                            <th className="w-full max-w-0 px-3 py-2 font-medium">{t("usageReport.chat")}</th>
                            <th className={TH}>{t("usageReport.answers")}</th>
                            <th className={TH}>{t("usageReport.tokens")}</th>
                            <th className={TH}>{t("usageReport.cost")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {report.chats.map((row) => (
                            <tr key={row.threadId} className="border-t border-border">
                                <td className="w-full max-w-0 px-3 py-2">
                                    {row.title !== null ? (
                                        <Link
                                            href={`/polar?thread=${encodeURIComponent(row.threadId)}`}
                                            className="block truncate no-underline hover:underline"
                                            title={t("usageReport.openChat", { title: row.title })}
                                        >
                                            {row.title}
                                        </Link>
                                    ) : (
                                        <span className="block truncate text-muted-foreground">
                                            {t("usageReport.deletedChat")}
                                        </span>
                                    )}
                                </td>
                                <td className={TD}>{row.answers.toLocaleString(locale)}</td>
                                <td className={TD}>{formatTokens(row.tokens, locale)}</td>
                                <td className={TD}>{formatUsd(row.costUsd, locale)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
