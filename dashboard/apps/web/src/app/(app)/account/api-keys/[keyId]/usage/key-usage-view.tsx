"use client";

/**
 * One key's usage, drawn in the browser. The heading, the last use and the
 * period picker paint with the page; only the figures wait, behind skeletons
 * shaped like them. The last report seen for a key and period is kept for the
 * tab, so going back to a period shows it at once and refreshes underneath.
 */

import Link from "next/link";
import { createDisplayFormat, describeDevice } from "@polaris/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useDisplayFormat, useDisplayPreferences } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { KeyUsage } from "@/app/(app)/account/api-keys/usage-actions";
import { ArrowLeft, BookOpen, Pencil, RotateCw } from "lucide-react";
import { Badge, Button, SegmentedControl, Skeleton, cn } from "@polaris/ui";
import type { Percentile } from "@/lib/api-usage/report";
import { USAGE_RANGES, type UsageRange } from "@/lib/api-usage/ranges";
import * as polls from "../../../account-polls";

type Translate = NamespaceTranslator<"account">;

export interface UsageKey {
    id: string;
    name: string;
    prefix: string;
    lastUsedAt: string | null;
    lastUsedIp: string | null;
    lastUsedUserAgent: string | null;
}

type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; usage: KeyUsage };

const CACHE_PREFIX = "polaris.api-key-usage.";

function cached(keyId: string, range: UsageRange): KeyUsage | null {
    try {
        const raw = sessionStorage.getItem(`${CACHE_PREFIX}${keyId}.${range}`);
        return raw ? (JSON.parse(raw) as KeyUsage) : null;
    } catch {
        return null;
    }
}

function remember(keyId: string, range: UsageRange, usage: KeyUsage) {
    try {
        sessionStorage.setItem(`${CACHE_PREFIX}${keyId}.${range}`, JSON.stringify(usage));
    } catch {
        // Storage refused (private window, quota): the next visit loads again.
    }
}

export function KeyUsageView({ apiKey }: { apiKey: UsageKey }) {
    const t = useTranslations("account");
    const [range, setRange] = useState<UsageRange>("24h");
    const [load, setLoad] = useState<Load>({ state: "loading" });
    const [attempt, setAttempt] = useState(0);
    const latest = useRef(0);

    useEffect(() => {
        const request = ++latest.current;
        const known = cached(apiKey.id, range);
        setLoad(known ? { state: "ready", usage: known } : { state: "loading" });
        polls
            .keyUsage({ keyId: apiKey.id, range })
            .then((result) => {
                if (request !== latest.current) return;
                if (result.usage) {
                    remember(apiKey.id, range, result.usage);
                    setLoad({ state: "ready", usage: result.usage });
                } else if (!known) setLoad({ state: "failed" });
            })
            .catch(() => {
                if (request === latest.current && !known) setLoad({ state: "failed" });
            });
    }, [apiKey.id, range, attempt]);

    return (
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <Link
                        href="/account/api-keys"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground"
                    >
                        <ArrowLeft className="size-3.5 shrink-0" />
                        {t("apiKeys.usage.back")}
                    </Link>
                    <h1
                        className="truncate text-[1.0625rem] font-semibold tracking-tight"
                        title={apiKey.name}
                    >
                        {t("apiKeys.usage.title", { name: apiKey.name })}
                    </h1>
                    <p className="truncate text-sm text-muted-foreground">
                        <span className="font-mono text-xs">{apiKey.prefix}</span>
                        {" - "}
                        {t("apiKeys.usage.lastUsed")}:{" "}
                        {apiKey.lastUsedAt ? (
                            <RelativeTime iso={apiKey.lastUsedAt} />
                        ) : (
                            t("apiKeys.usage.neverUsed")
                        )}
                        {apiKey.lastUsedUserAgent ? (
                            <span title={apiKey.lastUsedUserAgent}>
                                {" - "}
                                {apiKey.lastUsedIp
                                    ? t("apiKeys.usage.lastFrom", {
                                          device: describeDevice(apiKey.lastUsedUserAgent),
                                          ip: apiKey.lastUsedIp
                                      })
                                    : describeDevice(apiKey.lastUsedUserAgent)}
                            </span>
                        ) : null}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" asChild>
                        <Link href="/account/api-keys/reference" className="no-underline">
                            <BookOpen className="size-4 shrink-0" />
                            {t("apiKeys.list.reference")}
                        </Link>
                    </Button>
                    <Button size="sm" variant="outline" asChild>
                        <Link href={`/account/api-keys/${apiKey.id}`} className="no-underline">
                            <Pencil className="size-4 shrink-0" />
                            {t("apiKeys.usage.edit")}
                        </Link>
                    </Button>
                </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
                <SegmentedControl
                    aria-label={t("apiKeys.usage.range")}
                    value={range}
                    onValueChange={setRange}
                    options={USAGE_RANGES.map((value) => ({
                        value,
                        label: t(`apiKeys.usage.ranges.${value}` as const)
                    }))}
                />
                <p className="text-xs text-muted-foreground">{t("apiKeys.usage.kept")}</p>
            </div>

            <UsageData load={load} onRetry={() => setAttempt((count) => count + 1)} />
        </div>
    );
}

/** The figures: skeletons while they load, a retry when they failed, the report when they came. */
export function UsageData({ load, onRetry }: { load: Load; onRetry: () => void }) {
    const t = useTranslations("account");
    if (load.state === "loading") return <UsageSkeleton />;
    if (load.state === "failed") {
        return (
            <div
                role="alert"
                className="flex flex-col items-center gap-3 rounded-lg border border-border px-4 py-10 text-center"
            >
                <p className="text-sm text-danger">{t("apiKeys.usage.failed")}</p>
                <Button size="sm" variant="outline" onClick={onRetry}>
                    <RotateCw className="size-4 shrink-0" />
                    {t("apiKeys.usage.retry")}
                </Button>
            </div>
        );
    }
    const { usage } = load;
    if (usage.total === 0) {
        return (
            <div className="flex flex-col items-center gap-1 rounded-lg border border-border px-4 py-10 text-center">
                <p className="text-sm font-medium">{t("apiKeys.usage.empty")}</p>
                <p className="text-sm text-muted-foreground">{t("apiKeys.usage.emptyHint")}</p>
            </div>
        );
    }
    return <UsageReport usage={usage} />;
}

function UsageSkeleton() {
    return (
        <div className="flex flex-col gap-6" aria-busy="true">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {Array.from({ length: 6 }, (_, index) => (
                    <div
                        key={index}
                        className="flex flex-col gap-2 rounded-lg border border-border p-3"
                    >
                        <Skeleton className="h-3 w-20" />
                        <Skeleton className="h-5 w-14" />
                    </div>
                ))}
            </div>
            <Skeleton className="h-40 w-full rounded-lg" />
            <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
                <Skeleton className="h-48 w-full rounded-lg" />
                <Skeleton className="h-48 w-full rounded-lg" />
            </div>
        </div>
    );
}

function latency(value: Percentile | null, t: Translate, number: (n: number) => string): string {
    if (!value) return "-";
    return value.over
        ? t("apiKeys.usage.over", { ms: number(value.ms) })
        : t("apiKeys.usage.ms", { ms: number(value.ms) });
}

function statusTone(status: number): "success" | "warning" | "danger" {
    return status >= 500 ? "danger" : status >= 400 ? "warning" : "success";
}

function statusClass(status: number): "success" | "client" | "server" {
    return status >= 500 ? "server" : status >= 400 ? "client" : "success";
}

function UsageReport({ usage }: { usage: KeyUsage }) {
    const t = useTranslations("account");
    const format = useDisplayFormat();
    const number = (value: number) => format.number(value);
    const share = (value: number) =>
        format.number(usage.total > 0 ? value / usage.total : 0, {
            style: "percent",
            maximumFractionDigits: 1
        });
    const listed = usage.routes.reduce((sum, row) => sum + row.calls, 0);
    const rest = usage.total - listed;

    const tiles: { label: string; value: string; tone?: string }[] = [
        { label: t("apiKeys.usage.calls"), value: number(usage.total) },
        { label: t("apiKeys.usage.success"), value: number(usage.classes.success) },
        {
            label: t("apiKeys.usage.clientErrors"),
            value: number(usage.classes.client),
            tone: usage.classes.client > 0 ? "text-warning" : undefined
        },
        {
            label: t("apiKeys.usage.serverErrors"),
            value: number(usage.classes.server),
            tone: usage.classes.server > 0 ? "text-danger" : undefined
        },
        { label: t("apiKeys.usage.p50"), value: latency(usage.p50, t, number) },
        { label: t("apiKeys.usage.p95"), value: latency(usage.p95, t, number) }
    ];

    return (
        <div className="flex flex-col gap-6">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {tiles.map((tile) => (
                    <div key={tile.label} className="min-w-0 rounded-lg border border-border p-3">
                        <dt className="truncate text-xs text-muted-foreground" title={tile.label}>
                            {tile.label}
                        </dt>
                        <dd
                            className={cn(
                                "truncate text-base font-semibold tabular-nums",
                                tile.tone
                            )}
                            title={tile.value}
                        >
                            {tile.value}
                        </dd>
                    </div>
                ))}
            </dl>

            <CallsChart usage={usage} />

            <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
                <section className="flex min-w-0 flex-col gap-2">
                    <h2 className="text-sm font-semibold">{t("apiKeys.usage.byRoute")}</h2>
                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full min-w-[34rem] text-sm">
                            <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                                <tr>
                                    <th
                                        scope="col"
                                        className="w-full max-w-0 px-3 py-2 font-medium"
                                    >
                                        {t("apiKeys.usage.route")}
                                    </th>
                                    <th scope="col" className="px-3 py-2 text-right font-medium">
                                        {t("apiKeys.usage.calls")}
                                    </th>
                                    <th scope="col" className="px-3 py-2 text-right font-medium">
                                        {t("apiKeys.usage.errors")}
                                    </th>
                                    <th scope="col" className="px-3 py-2 text-right font-medium">
                                        {t("apiKeys.usage.p50")}
                                    </th>
                                    <th scope="col" className="px-3 py-2 text-right font-medium">
                                        {t("apiKeys.usage.p95")}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {usage.routes.map((row, index) => {
                                    const label = `${row.method} ${row.route}`;
                                    const anchor = usage.anchors[index];
                                    return (
                                        <tr key={label} className="border-t border-border">
                                            <td className="max-w-0 px-3 py-2">
                                                {anchor ? (
                                                    <Link
                                                        href={`/account/api-keys/reference#${anchor}`}
                                                        className="block truncate font-mono text-xs no-underline hover:underline"
                                                        aria-label={t("apiKeys.usage.openRoute", {
                                                            route: label
                                                        })}
                                                        title={t("apiKeys.usage.openRoute", {
                                                            route: label
                                                        })}
                                                    >
                                                        {label}
                                                    </Link>
                                                ) : (
                                                    <span
                                                        className="block truncate font-mono text-xs"
                                                        title={label}
                                                    >
                                                        {label}
                                                    </span>
                                                )}
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                                                {number(row.calls)}
                                            </td>
                                            <td
                                                className={cn(
                                                    "whitespace-nowrap px-3 py-2 text-right tabular-nums",
                                                    row.errors > 0
                                                        ? "text-danger"
                                                        : "text-muted-foreground"
                                                )}
                                            >
                                                {number(row.errors)}
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">
                                                {latency(row.p50, t, number)}
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">
                                                {latency(row.p95, t, number)}
                                            </td>
                                        </tr>
                                    );
                                })}
                                {rest > 0 ? (
                                    <tr className="border-t border-border text-muted-foreground">
                                        <td className="px-3 py-2 text-xs">
                                            {t("apiKeys.usage.other")}
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                                            {number(rest)}
                                        </td>
                                        <td colSpan={3} />
                                    </tr>
                                ) : null}
                            </tbody>
                        </table>
                    </div>
                </section>

                <section className="flex min-w-0 flex-col gap-2">
                    <h2 className="text-sm font-semibold">{t("apiKeys.usage.byStatus")}</h2>
                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full text-sm">
                            <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                                <tr>
                                    <th scope="col" className="px-3 py-2 font-medium">
                                        {t("apiKeys.usage.status")}
                                    </th>
                                    <th scope="col" className="px-3 py-2 text-right font-medium">
                                        {t("apiKeys.usage.calls")}
                                    </th>
                                    <th scope="col" className="px-3 py-2 text-right font-medium">
                                        {t("apiKeys.usage.share")}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {usage.statuses.map((row) => (
                                    <tr key={row.status} className="border-t border-border">
                                        <td className="whitespace-nowrap px-3 py-2">
                                            <Badge
                                                variant={statusTone(row.status)}
                                                title={t(
                                                    `apiKeys.usage.classes.${statusClass(row.status)}` as const
                                                )}
                                            >
                                                {row.status}
                                            </Badge>
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                                            {number(row.calls)}
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">
                                            {share(row.calls)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            </div>
        </div>
    );
}

const CHART_HEIGHT = 120;

/**
 * Calls per bucket as bars, the failed part of each drawn on top in the danger
 * tone. Inline SVG, as the other charts here: no axes beyond the two ends, and
 * each bar names its own time and counts on hover.
 */
function CallsChart({ usage }: { usage: KeyUsage }) {
    const t = useTranslations("account");
    const format = useDisplayFormat();
    const preferences = useDisplayPreferences();
    const utc = useMemo(
        () => createDisplayFormat({ ...preferences, timeZone: "UTC" }),
        [preferences]
    );
    const peak = Math.max(...usage.series.map((point) => point.calls), 1);
    const width = usage.series.length;
    const when = (time: number) =>
        usage.bucket === "day"
            ? t("apiKeys.usage.utcDay", { date: utc.date(time) })
            : format.dateTime(time);
    const first = usage.series[0];
    const last = usage.series[usage.series.length - 1];

    return (
        <section className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">{t("apiKeys.usage.overTime")}</h2>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                        <span className="size-2 rounded-sm bg-primary" aria-hidden="true" />
                        {t("apiKeys.usage.calls")}
                    </span>
                    <span className="inline-flex items-center gap-1">
                        <span className="size-2 rounded-sm bg-danger" aria-hidden="true" />
                        {t("apiKeys.usage.errorsOverTime")}
                    </span>
                </span>
            </div>
            <div className="rounded-lg border border-border p-3">
                <svg
                    viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
                    preserveAspectRatio="none"
                    className="block h-32 w-full"
                    role="img"
                    aria-label={`${t("apiKeys.usage.overTime")}: ${format.number(usage.total)}`}
                >
                    {usage.series.map((point, index) => {
                        const height = (point.calls / peak) * CHART_HEIGHT;
                        const failed = (point.errors / peak) * CHART_HEIGHT;
                        return (
                            <g key={point.t}>
                                <title>
                                    {`${when(point.t)} - ${t("apiKeys.usage.calls")}: ${format.number(point.calls)}, ${t("apiKeys.usage.errors")}: ${format.number(point.errors)}`}
                                </title>
                                {/* The full column is the hover target, so a quiet hour still says it was quiet. */}
                                <rect
                                    x={index}
                                    y={0}
                                    width={1}
                                    height={CHART_HEIGHT}
                                    fill="transparent"
                                />
                                {height > 0 ? (
                                    <rect
                                        x={index + 0.1}
                                        y={CHART_HEIGHT - height}
                                        width={0.8}
                                        height={height}
                                        className="fill-primary"
                                    />
                                ) : null}
                                {failed > 0 ? (
                                    <rect
                                        x={index + 0.1}
                                        y={CHART_HEIGHT - failed}
                                        width={0.8}
                                        height={failed}
                                        className="fill-danger"
                                    />
                                ) : null}
                            </g>
                        );
                    })}
                </svg>
                {first && last ? (
                    <div className="mt-1 flex justify-between gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{when(first.t)}</span>
                        <span className="truncate">{when(last.t)}</span>
                    </div>
                ) : null}
            </div>
        </section>
    );
}
