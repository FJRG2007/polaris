"use client";

/**
 * Usage: what the project is actually consuming, per service.
 *
 * The figures come from the collected history rather than a live probe of every
 * container - opening a summary screen should not fan out a Docker call per
 * service - so they carry the time they were sampled at instead of pretending to
 * be instantaneous.
 *
 * The screen paints from the last answer it held and then keeps itself current on
 * the collector's own cadence, so opening it shows numbers rather than a spinner
 * and leaving it open shows this minute's rather than the ones it opened with.
 */

import { useCallback } from "react";
import { Button } from "@polaris/ui";
import { SettingsCard } from "../project-settings";
import { COLLECT_TICK_MS } from "@/lib/metrics-shared";
import { useLiveRead } from "@/components/use-live-resource";
import type { StatementView } from "@/lib/billing/statement";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ProjectUsage } from "@/lib/deploy-project-service";
import { Database, Layers, Loader2, RefreshCw } from "lucide-react";
import { StatementTotals } from "@/components/billing/statement-parts";
import { projectMonthUsageAction, projectUsageAction } from "../project-actions";

function formatBytes(bytes: number | null): string {
    if (bytes == null) return "-";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function UsageSection({ projectId }: { projectId: string }) {
    const t = useTranslations("deploySettings");
    const display = useDisplayFormat();

    const load = useCallback(async (): Promise<ProjectUsage> => {
        const result = await projectUsageAction(projectId);
        if (result.error || !result.usage) throw new Error(result.error ?? t("usage.loadFailed"));
        return result.usage;
    }, [projectId, t]);

    const {
        data: usage,
        loading,
        error,
        stale,
        refreshing,
        refresh
    } = useLiveRead<ProjectUsage>({
        load,
        cacheKey: `deploy.usage.${projectId}`,
        // Nothing new exists between collector ticks, so asking faster would only
        // redraw identical figures.
        intervalMs: COLLECT_TICK_MS
    });

    return (
        <div className="flex flex-col gap-4">
            <SettingsCard
                title={t("usage.totals")}
                description={t("usage.totalsHint")}
            >
                {loading ? (
                    <div className="flex justify-center py-6 text-muted-foreground">
                        <Loader2 className="size-5 animate-spin" />
                    </div>
                ) : (
                    <>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <Stat label={t("usage.services")} value={String(usage?.totals.services ?? 0)} hint={t("usage.running", { count: usage?.totals.running ?? 0 })} />
                            <Stat
                                label={t("usage.cpu")}
                                value={usage?.totals.cpuPercent == null ? "-" : `${usage.totals.cpuPercent}%`}
                                hint={t("usage.cpuHint")}
                            />
                            <Stat label={t("usage.memory")} value={formatBytes(usage?.totals.memUsedBytes ?? null)} hint={t("usage.resident")} />
                            <Stat
                                label={t("usage.volumes")}
                                value={formatBytes(usage?.totals.volumeBytes ?? null)}
                                hint={t("usage.attached", { count: usage?.totals.volumes ?? 0 })}
                            />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-xs text-muted-foreground">
                                {usage?.sampledAt
                                    ? t("usage.sampled", { time: display.dateTime(usage.sampledAt) })
                                    : t("usage.noSamples")}
                            </p>
                            <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
                                {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                                {t("usage.refresh")}
                            </Button>
                        </div>
                    </>
                )}
                {/* A read that failed with nothing to show is the failure; one that
                    failed over figures already on screen only means they stopped
                    moving, which is a warning rather than an error. */}
                {error && <p className="text-sm text-danger">{error}</p>}
                {stale && <p className="text-sm text-warning">{t("usage.stale", { reason: stale })}</p>}
            </SettingsCard>

            <MonthCard projectId={projectId} />

            <SettingsCard title={t("usage.byService")} description={t("usage.byServiceHint")}>
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[32rem] text-sm">
                        <thead>
                            <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                                <th className="px-2 py-1.5 font-medium">{t("usage.service")}</th>
                                <th className="px-2 py-1.5 font-medium">{t("usage.environment")}</th>
                                <th className="px-2 py-1.5 text-right font-medium">{t("usage.cpu")}</th>
                                <th className="px-2 py-1.5 text-right font-medium">{t("usage.memory")}</th>
                                <th className="px-2 py-1.5 text-right font-medium">{t("usage.volumes")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(usage?.services ?? []).map((service) => (
                                <tr key={service.id} className="border-b border-border/40 last:border-0">
                                    <td className="px-2 py-2">
                                        <span className="flex min-w-0 items-center gap-2">
                                            {service.kind === "database" ? (
                                                <Database className="size-3.5 shrink-0 text-accent" />
                                            ) : (
                                                <Layers className="size-3.5 shrink-0 text-muted-foreground" />
                                            )}
                                            <span className="truncate">{service.name}</span>
                                            <span
                                                className={`size-1.5 shrink-0 rounded-full ${service.running ? "bg-success-solid" : "bg-muted-foreground"}`}
                                                title={service.running ? t("usage.isRunning") : t("usage.notRunning")}
                                            />
                                        </span>
                                    </td>
                                    <td className="px-2 py-2 text-muted-foreground">{service.environmentName}</td>
                                    <td className="px-2 py-2 text-right tabular-nums">
                                        {service.cpuPercent == null ? "-" : `${service.cpuPercent}%`}
                                    </td>
                                    <td className="px-2 py-2 text-right tabular-nums">
                                        {formatBytes(service.memUsedBytes)}
                                    </td>
                                    <td className="px-2 py-2 text-right tabular-nums">
                                        {service.volumeCount === 0 ? "-" : formatBytes(service.volumeBytes)}
                                    </td>
                                </tr>
                            ))}
                            {(usage?.services.length ?? 0) === 0 && !loading && (
                                <tr>
                                    <td colSpan={5} className="px-2 py-6 text-center text-muted-foreground">
                                        {t("usage.empty")}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </SettingsCard>
        </div>
    );
}

/** How often this month's figures are read again. They are folded by the hour,
 *  so this only has to keep up with the hour or two not folded yet. */
const MONTH_POLL_MS = 5 * 60_000;

/**
 * What the project has used so far this month, and what it comes to at the
 * instance's prices when it has any - the same line Management > Billing shows
 * for it, so whoever runs the project does not have to ask what it costs.
 */
function MonthCard({ projectId }: { projectId: string }) {
    const t = useTranslations("deploySettings");
    const load = useCallback(async (): Promise<StatementView> => {
        const result = await projectMonthUsageAction(projectId);
        if (result.error || !result.month) throw new Error(result.error ?? t("usage.monthFailed"));
        return result.month;
    }, [projectId, t]);
    const { data, error, stale } = useLiveRead<StatementView>({
        load,
        cacheKey: `deploy.month.${projectId}`,
        intervalMs: MONTH_POLL_MS
    });

    return (
        <SettingsCard
            title={data ? t("usage.monthSoFar", { month: data.monthLabel }) : t("usage.thisMonthSoFar")}
            description={data && !data.statement.rates ? t("usage.monthNoPrices") : t("usage.monthWithPrices")}
        >
            <StatementTotals view={data} />
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            {stale ? <p className="text-sm text-warning">{t("usage.stale", { reason: stale })}</p> : null}
        </SettingsCard>
    );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
    return (
        <div className="rounded-md border border-border/60 p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-0.5 text-lg font-medium tabular-nums">{value}</p>
            <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
    );
}
