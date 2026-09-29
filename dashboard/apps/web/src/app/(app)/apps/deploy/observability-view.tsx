"use client";

/**
 * Observability: the whole environment at once.
 *
 * The Metrics tab on a service answers "how is this one doing". This screen
 * answers the question that actually gets asked - "which one is the problem" -
 * so it puts every service side by side and lets one be expanded rather than
 * making the reader open each panel in turn to compare them.
 *
 * Alarms are not duplicated here. A threshold that emails somebody at 3am belongs
 * in Watch, which owns that for the whole instance; this screen links to it
 * rather than growing a second, project-shaped copy of the same feature.
 */

import Link from "next/link";
import { useState } from "react";
import { Button, cn } from "@polaris/ui";
import { dbEngineLabel } from "@polaris/core";
import { dbTone, StatusPill } from "./deploy-view";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { DbEngineIcon } from "@/components/db-engine-icon";
import { Activity, ChevronDown, Layers } from "lucide-react";
import { CONSUMPTION_METRICS, MetricsHistory, percent, type MetricSpec } from "@/components/metrics-history";

interface ServiceRef {
    id: string;
    name: string;
    running: boolean;
}

interface DatabaseRef {
    id: string;
    name: string;
    engine: string;
    status: string;
}

function formatRate(bytesPerSec: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytesPerSec;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}/s`;
}

interface HttpPoint {
    t: number;
    requests: number;
    errorRate: number | null;
    avgResponseMs: number | null;
    bytesPerSec: number;
}

const traffic = (t: NamespaceTranslator<"deploy">): MetricSpec<HttpPoint>[] => [
    {
        key: "req",
        label: t("observability.requests"),
        value: (point) => point.requests,
        format: (value) => String(Math.round(value)),
        tone: "primary",
        summary: "sum"
    },
    {
        key: "err",
        label: t("observability.errorRate"),
        value: (point) => point.errorRate,
        format: percent,
        tone: "danger",
        max: 100,
        summary: "avg"
    },
    {
        key: "rt",
        label: t("observability.responseTime"),
        value: (point) => point.avgResponseMs,
        format: (value) => `${Math.round(value)} ms`,
        tone: "warning",
        summary: "avg"
    },
    {
        key: "net",
        label: t("observability.traffic"),
        value: (point) => point.bytesPerSec,
        format: formatRate,
        tone: "success",
        summary: "avg"
    }
];

export function ObservabilityView({
    environmentName,
    services,
    databases
}: {
    environmentName: string;
    services: ServiceRef[];
    databases: DatabaseRef[];
}) {
    // The first running service starts open, because a screen of ten collapsed
    // rows answers nothing - and a stopped one has no chart to show.
    const t = useTranslations("deploy");
    const [open, setOpen] = useState<string | null>(services.find((service) => service.running)?.id ?? null);

    return (
        <div className="flex w-full flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("observability.title")}</h1>
                    <p className="text-sm text-muted-foreground">{t("observability.intro", { environment: environmentName })}</p>
                </div>
                <Button asChild variant="ghost" size="sm">
                    <Link href="/watch">
                        <Activity className="size-4" /> {t("observability.alarms")}
                    </Link>
                </Button>
            </div>

            {services.length === 0 && databases.length === 0 ? (
                <div className="rounded-lg border border-border/60 px-4 py-16 text-center">
                    <p className="text-sm text-muted-foreground">
                        {t("observability.empty")}
                    </p>
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    {services.map((service) => (
                        <ServicePanel
                            key={service.id}
                            service={service}
                            open={open === service.id}
                            onToggle={() => setOpen(open === service.id ? null : service.id)}
                        />
                    ))}

                    {databases.length > 0 && (
                        <section className="rounded-lg border border-border/60 p-4">
                            <h2 className="text-sm font-medium">{t("observability.databases")}</h2>
                            <p className="mb-2 text-xs text-muted-foreground">{t("observability.databasesHint")}</p>
                            <div className="overflow-hidden rounded-md border border-border/60">
                                {databases.map((database) => (
                                    <div
                                        key={database.id}
                                        className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2 last:border-0"
                                    >
                                        <span className="flex min-w-0 items-center gap-2">
                                            <DbEngineIcon engine={database.engine} className="size-5" />
                                            <span className="truncate text-sm">{database.name}</span>
                                            <span className="shrink-0 text-xs text-muted-foreground">
                                                {dbEngineLabel(database.engine)}
                                            </span>
                                        </span>
                                        <StatusPill tone={dbTone(database.status)} label={database.status} />
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
                </div>
            )}
        </div>
    );
}

function ServicePanel({
    service,
    open,
    onToggle
}: {
    service: ServiceRef;
    open: boolean;
    onToggle: () => void;
}) {
    const t = useTranslations("deploy");
    return (
        <section className="overflow-hidden rounded-lg border border-border/60">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
            >
                <Layers className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{service.name}</span>
                <span
                    className={cn("size-1.5 shrink-0 rounded-full", service.running ? "bg-success-solid" : "bg-muted-foreground")}
                    title={service.running ? t("observability.running") : t("observability.notRunning")}
                />
                <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
            </button>

            {open && (
                <div className="flex flex-col gap-4 border-t border-border/60 p-4">
                    <div>
                        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {t("observability.consumption")}
                        </h3>
                        <MetricsHistory
                            endpoint={`/api/deploy/apps/${service.id}/metrics/history`}
                            live={`/api/deploy/apps/${service.id}/metrics/stream`}
                            metrics={CONSUMPTION_METRICS}
                        />
                    </div>
                    <div>
                        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {t("observability.traffic")}
                        </h3>
                        <MetricsHistory<HttpPoint>
                            endpoint={`/api/deploy/apps/${service.id}/http-metrics`}
                            metrics={traffic(t)}
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                            {t("observability.trafficHint")}
                        </p>
                    </div>
                </div>
            )}
        </section>
    );
}
