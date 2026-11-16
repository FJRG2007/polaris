"use client";

/**
 * Lab performance: Lighthouse audits of the site's home page, mobile and
 * desktop, beside the field vitals its visitors measured. A person who may edit
 * the site runs one now or schedules them; the card polls while one is queued
 * or running. Without the host daemon the controls are off and the card says why.
 */

import { FlaskConical } from "lucide-react";
import type { AnalyticsScope } from "./site-catalog";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useState, useTransition } from "react";
import type { LabFrequency, LabOverview, LabRunView } from "@/lib/analytics-lab";
import { getLabAction, runLabCheckAction, setLabFrequencyAction } from "./actions";
import { Button, Card, CardBody, CardHeader, CardTitle, Select, Skeleton, cn } from "@polaris/ui";

const SCORES = ["performance", "accessibility", "bestPractices", "seo"] as const;
const METRICS = ["lcpMs", "cls", "tbtMs", "fcpMs", "siMs", "ttiMs"] as const;
const POLL_MS = 5_000;

/** Lighthouse's own bands: 90 and up good, 50 to 89 needs work, below poor. */
export function scoreInk(value: number | null): string {
    if (value === null) return "text-muted-foreground";
    return value >= 90 ? "text-success-ink" : value >= 50 ? "text-warning-ink" : "text-danger-ink";
}

export function formatLabMetric(metric: (typeof METRICS)[number], value: number | null): string {
    if (value === null) return "-";
    if (metric === "cls") return value.toFixed(2);
    return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

/** The newest finished or pending run of each strategy. */
export function latestByStrategy(runs: readonly LabRunView[]): Partial<Record<LabRunView["strategy"], LabRunView>> {
    const out: Partial<Record<LabRunView["strategy"], LabRunView>> = {};
    for (const run of runs) if (!out[run.strategy]) out[run.strategy] = run;
    return out;
}

export function LabCard({ scope, siteId, canEdit }: { scope: AnalyticsScope; siteId: string; canEdit: boolean }) {
    const t = useTranslations("analytics");
    const format = useDisplayFormat();
    const [lab, setLab] = useState<LabOverview | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const load = useCallback(async () => {
        const result = await getLabAction({ scopeType: scope, scopeId: siteId });
        if (result.error || !result.lab) setFailure(result.error ?? null);
        else setLab(result.lab);
    }, [scope, siteId]);

    useEffect(() => {
        setLab(null);
        setFailure(null);
        void load();
    }, [load]);

    const active = lab?.runs.some((run) => run.status === "queued" || run.status === "running") ?? false;
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => void load(), POLL_MS);
        return () => window.clearInterval(timer);
    }, [active, load]);

    const runNow = () => {
        setFailure(null);
        startTransition(async () => {
            const result = await runLabCheckAction({ scopeType: scope, scopeId: siteId });
            if (result.error) setFailure(result.error);
            await load();
        });
    };

    const schedule = (frequency: LabFrequency) => {
        if (!lab || frequency === lab.frequency) return;
        const before = lab;
        // Shown at once, put back if the save fails.
        setLab({ ...lab, frequency });
        setFailure(null);
        startTransition(async () => {
            const result = await setLabFrequencyAction({ scopeType: scope, scopeId: siteId, frequency });
            if (result.error) {
                setLab(before);
                setFailure(result.error);
                return;
            }
            await load();
        });
    };

    const blocked = !lab ? null : !lab.available ? t("lab.limited") : !lab.url ? t("lab.noUrl") : null;
    const latest = lab ? latestByStrategy(lab.runs) : {};
    const history = lab?.runs.filter((run) => run.status === "ok" || run.status === "error").slice(0, 20) ?? [];

    return (
        <Card className="min-w-0">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                    <FlaskConical className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {t("lab.title")}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 pt-0">
                {!lab ? (
                    failure ? (
                        <p className="text-sm text-destructive">{failure}</p>
                    ) : (
                        <Skeleton className="h-28 w-full" />
                    )
                ) : (
                    <>
                        {lab.url && (
                            <p className="truncate text-sm text-muted-foreground" title={lab.url}>
                                {t("lab.intro", { url: lab.url })}
                            </p>
                        )}
                        {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
                        <div className="flex flex-wrap items-end gap-3">
                            <Button
                                size="sm"
                                onClick={runNow}
                                disabled={!canEdit || !!blocked || active || pending}
                                title={active ? t("lab.busy") : undefined}
                            >
                                {active ? t("lab.running") : t("lab.run")}
                            </Button>
                            <div className="flex min-w-40 flex-col gap-1 text-sm">
                                <span className="font-medium">{t("lab.schedule")}</span>
                                <Select
                                    value={lab.frequency}
                                    aria-label={t("lab.schedule")}
                                    disabled={!canEdit || (!!blocked && lab.frequency === "off") || pending}
                                    onValueChange={(value) => schedule(value as LabFrequency)}
                                    options={(["off", "daily", "weekly", "monthly"] as const).map((value) => ({
                                        value,
                                        label: t(`lab.frequency.${value}`)
                                    }))}
                                />
                            </div>
                            {lab.nextAt && (
                                <span className="pb-2 text-xs text-muted-foreground">
                                    {t("lab.next", { when: format.dateTime(lab.nextAt) })}
                                </span>
                            )}
                        </div>
                        {failure && <p className="text-sm text-destructive">{failure}</p>}
                        {lab.runs.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("lab.none")}</p>
                        ) : (
                            <div className="grid gap-3 md:grid-cols-2">
                                {(["mobile", "desktop"] as const).map((strategy) => {
                                    const run = latest[strategy];
                                    return (
                                        <div key={strategy} className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-3">
                                            <div className="flex min-w-0 items-center justify-between gap-2">
                                                <span className="truncate text-sm font-medium">{t(`lab.strategy.${strategy}`)}</span>
                                                {run && (
                                                    <span className="truncate text-xs text-muted-foreground">
                                                        {run.status === "queued"
                                                            ? t("lab.queued")
                                                            : run.status === "running"
                                                              ? t("lab.running")
                                                              : format.dateTime(run.finishedAt ?? run.createdAt)}
                                                    </span>
                                                )}
                                            </div>
                                            {!run || run.status === "queued" || run.status === "running" ? (
                                                <Skeleton className="h-16 w-full" />
                                            ) : run.status === "error" ? (
                                                <p className="text-sm text-destructive">{t(`lab.error.${run.error ?? "failed"}`)}</p>
                                            ) : (
                                                <>
                                                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                                        {SCORES.map((key) => (
                                                            <div key={key} className="flex min-w-0 flex-col">
                                                                <span className={cn("text-xl font-semibold tabular-nums", scoreInk(run[key]))}>
                                                                    {run[key] ?? "-"}
                                                                </span>
                                                                <span className="truncate text-xs text-muted-foreground" title={t(`lab.score.${key}`)}>
                                                                    {t(`lab.score.${key}`)}
                                                                </span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">
                                                        {METRICS.map((key) => (
                                                            <div key={key} className="flex min-w-0 justify-between gap-2">
                                                                <dt className="truncate text-muted-foreground" title={t(`lab.metric.${key}`)}>
                                                                    {t(`lab.metric.${key}`)}
                                                                </dt>
                                                                <dd className="shrink-0 tabular-nums">{formatLabMetric(key, run[key])}</dd>
                                                            </div>
                                                        ))}
                                                    </dl>
                                                    {run.lighthouseVersion && (
                                                        <span className="text-xs text-muted-foreground">
                                                            {t("lab.version", { version: run.lighthouseVersion })}
                                                        </span>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        {history.length > 2 && (
                            <div className="min-w-0 overflow-x-auto">
                                <p className="pb-1 text-xs font-medium text-muted-foreground">{t("lab.history")}</p>
                                <table className="w-full min-w-[32rem] text-sm">
                                    <thead>
                                        <tr className="text-start text-xs text-muted-foreground">
                                            <th className="py-1 pe-3 font-medium">{t("lab.when")}</th>
                                            <th className="py-1 pe-3 font-medium">{t("lab.device")}</th>
                                            {SCORES.map((key) => (
                                                <th key={key} className="py-1 pe-3 text-end font-medium">
                                                    {t(`lab.score.${key}`)}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {history.map((run) => (
                                            <tr key={run.id} className="border-t border-border">
                                                <td className="py-1.5 pe-3 whitespace-nowrap" title={t(`lab.trigger.${run.triggeredBy}`)}>
                                                    {format.dateTime(run.finishedAt ?? run.createdAt)}
                                                </td>
                                                <td className="py-1.5 pe-3">{t(`lab.strategy.${run.strategy}`)}</td>
                                                {run.status === "error" ? (
                                                    <td colSpan={SCORES.length} className="py-1.5 text-end text-xs text-destructive">
                                                        {t(`lab.error.${run.error ?? "failed"}`)}
                                                    </td>
                                                ) : (
                                                    SCORES.map((key) => (
                                                        <td key={key} className={cn("py-1.5 pe-3 text-end tabular-nums", scoreInk(run[key]))}>
                                                            {run[key] ?? "-"}
                                                        </td>
                                                    ))
                                                )}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}
            </CardBody>
        </Card>
    );
}
