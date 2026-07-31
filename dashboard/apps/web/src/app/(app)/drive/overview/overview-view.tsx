"use client";

/**
 * Overview: one section per connected device with its metrics - storage, health
 * and disks (UniFi UNAS) or properties and usage (any other backend). This is
 * the "manage the devices" view; the Files page is purely for browsing files.
 * Metrics load on the client behind a skeleton so a slow device never blocks the
 * page, and each section links straight to that device's files.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FolderOpen, HardDrive } from "lucide-react";
import { Button, Card, CardBody, Skeleton } from "@polaris/ui";
import { formatBytes, temperatureSuffix, toDisplayTemperature, type TemperatureUnit } from "@polaris/core";
import type { UnasMetrics as UnasMetricsData } from "@/lib/unifi-unas";
import { useDisplayPreferences } from "@/components/display-format";
import { MetricsHistory, percent, ratioPercent, type MetricSpec } from "@/components/metrics-history";
import { HardwarePanel } from "../hardware-panel";
import { UnasMetrics } from "../unas-metrics";
import type { ConnectionSummary } from "../types";

/** "6.7 GB / 16 GB", or nothing when the device reported neither side. */
function amountOf(used: number | null, total: number | null): string | null {
    if (used === null) return null;
    return total === null ? formatBytes(used) : `${formatBytes(used)} / ${formatBytes(total)}`;
}

/** Charts for a rich UniFi UNAS device: CPU, temperature, memory, storage. The
 *  temperature series is converted up front so the axis, not just the label,
 *  is in the unit the reader chose. */
function unasMetrics(unit: TemperatureUnit): MetricSpec[] {
    return [
        { key: "cpu", label: "CPU", value: (point) => point.cpuPercent, format: percent, tone: "primary", max: 100 },
        {
            key: "temp",
            label: "CPU temperature",
            value: (point) => (point.cpuTempC === null ? null : toDisplayTemperature(point.cpuTempC, unit)),
            format: (value) => `${Math.round(value)} ${temperatureSuffix(unit)}`,
            tone: "warning"
        },
        {
            key: "mem",
            label: "Memory",
            value: (point) => ratioPercent(point.memUsedBytes, point.memTotalBytes),
            describe: (point) => amountOf(point.memUsedBytes, point.memTotalBytes),
            format: percent,
            tone: "success",
            max: 100
        },
        storageMetric
    ];
}

/** Any other backend reports disk usage only. */
const storageMetric: MetricSpec = {
    key: "disk",
    label: "Storage",
    value: (point) => ratioPercent(point.diskUsedBytes, point.diskTotalBytes),
    describe: (point) => amountOf(point.diskUsedBytes, point.diskTotalBytes),
    format: percent,
    tone: "primary",
    max: 100
};

/** Consumption history for a device, below its live panel. */
function DeviceHistory({ connection }: { connection: ConnectionSummary }) {
    const { temperature } = useDisplayPreferences();
    const metrics = useMemo(
        () => (connection.kind === "unifi-unas" ? unasMetrics(temperature) : [storageMetric]),
        [connection.kind, temperature]
    );

    return (
        <div>
            <h3 className="mb-1 text-sm font-medium">History</h3>
            <MetricsHistory
                endpoint={`/api/drive/metrics-history?c=${encodeURIComponent(connection.id)}`}
                metrics={metrics}
            />
        </div>
    );
}

function UnasSection({ connection }: { connection: ConnectionSummary }) {
    const [metrics, setMetrics] = useState<UnasMetricsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        fetch(`/api/drive/unas-metrics?c=${encodeURIComponent(connection.id)}`, { signal: controller.signal })
            .then(async (res) => {
                const body = await res.json();
                if (!res.ok) throw new Error(body.error ?? "Unable to reach the device");
                setMetrics(body.metrics as UnasMetricsData);
            })
            .catch((caught) => {
                if (!controller.signal.aborted) {
                    setError(caught instanceof Error ? caught.message : "Unable to reach the device");
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [connection.id]);

    if (loading) {
        return (
            <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                        <Skeleton key={index} className="h-20" />
                    ))}
                </div>
                <Skeleton className="h-40" />
            </div>
        );
    }
    if (error) {
        return (
            <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</div>
        );
    }
    return metrics ? <UnasMetrics metrics={metrics} /> : null;
}

export function OverviewView({ connections }: { connections: ConnectionSummary[] }) {
    if (connections.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    No devices yet. Add one from the Files page to see its metrics here.
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-8">
            {connections.map((connection) => (
                <section key={connection.id} className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
                        <div className="flex items-center gap-2">
                            <HardDrive className="size-5 text-primary" />
                            <h2 className="text-base font-semibold">{connection.name}</h2>
                        </div>
                        <Button asChild size="sm" variant="secondary">
                            <Link href={`/drive?c=${connection.id}`}>
                                <FolderOpen className="size-4" />
                                Browse files
                            </Link>
                        </Button>
                    </div>
                    {connection.kind === "unifi-unas" ? (
                        <UnasSection connection={connection} />
                    ) : (
                        <HardwarePanel connection={connection} />
                    )}
                    <DeviceHistory connection={connection} />
                </section>
            ))}
        </div>
    );
}
