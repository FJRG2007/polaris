"use client";

/**
 * Usage: what the project is actually consuming, per service.
 *
 * The figures come from the collected history rather than a live probe of every
 * container - opening a summary screen should not fan out a Docker call per
 * service - so they carry the time they were sampled at instead of pretending to
 * be instantaneous.
 */

import { Button } from "@polaris/ui";
import { useEffect, useState } from "react";
import { SettingsCard } from "../project-settings";
import { projectUsageAction } from "../project-actions";
import { useDisplayFormat } from "@/components/display-format";
import type { ProjectUsage } from "@/lib/deploy-project-service";
import { Database, Layers, Loader2, RefreshCw } from "lucide-react";

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
    const display = useDisplayFormat();
    const [usage, setUsage] = useState<ProjectUsage | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    function load() {
        setLoading(true);
        void projectUsageAction(projectId)
            .then((result) => {
                if (result.error || !result.usage) {
                    setError(result.error ?? "Could not load the usage");
                    return;
                }
                setError(null);
                setUsage(result.usage);
            })
            .finally(() => setLoading(false));
    }

    useEffect(load, [projectId]);

    return (
        <div className="flex flex-col gap-4">
            <SettingsCard
                title="Totals"
                description="Summed across every service that reported a sample in the last half hour."
            >
                {loading && !usage ? (
                    <div className="flex justify-center py-6 text-muted-foreground">
                        <Loader2 className="size-5 animate-spin" />
                    </div>
                ) : (
                    <>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <Stat label="Services" value={String(usage?.totals.services ?? 0)} hint={`${usage?.totals.running ?? 0} running`} />
                            <Stat
                                label="CPU"
                                value={usage?.totals.cpuPercent == null ? "-" : `${usage.totals.cpuPercent}%`}
                                hint="Across reporting services"
                            />
                            <Stat label="Memory" value={formatBytes(usage?.totals.memUsedBytes ?? null)} hint="Resident" />
                            <Stat
                                label="Volumes"
                                value={formatBytes(usage?.totals.volumeBytes ?? null)}
                                hint={`${usage?.totals.volumes ?? 0} attached`}
                            />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-xs text-muted-foreground">
                                {usage?.sampledAt
                                    ? `Sampled ${display.dateTime(usage.sampledAt)}`
                                    : "No samples yet. The collector writes one every few minutes."}
                            </p>
                            <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
                                {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                                Refresh
                            </Button>
                        </div>
                    </>
                )}
                {error && <p className="text-sm text-danger">{error}</p>}
            </SettingsCard>

            <SettingsCard title="By service" description="A service with no figures is not reporting - usually because it is not running.">
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[32rem] text-sm">
                        <thead>
                            <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                                <th className="px-2 py-1.5 font-medium">Service</th>
                                <th className="px-2 py-1.5 font-medium">Environment</th>
                                <th className="px-2 py-1.5 text-right font-medium">CPU</th>
                                <th className="px-2 py-1.5 text-right font-medium">Memory</th>
                                <th className="px-2 py-1.5 text-right font-medium">Volumes</th>
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
                                                className={`size-1.5 shrink-0 rounded-full ${service.running ? "bg-success" : "bg-muted-foreground"}`}
                                                title={service.running ? "Running" : "Not running"}
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
                                        No services in this project yet.
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

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
    return (
        <div className="rounded-md border border-border/60 p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-0.5 text-lg font-medium tabular-nums">{value}</p>
            <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
    );
}
