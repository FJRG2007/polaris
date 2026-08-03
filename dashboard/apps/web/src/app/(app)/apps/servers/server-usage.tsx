"use client";

/**
 * Where a server's CPU, memory and disk went, and what is holding them.
 *
 * The panel paints before the machine answers. Reading this costs an SSH session
 * to somebody's box, so the shell, the labels and the bars are on screen at once
 * and only the numbers arrive late - a dialog that renders nothing until a remote
 * shell has run is a dialog that looks broken on every slow server.
 *
 * Containers and processes are ranked together on purpose. The question behind
 * "what is eating this machine" is never "which of these two kinds is it".
 */

import { Box, Cpu } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Skeleton } from "@polaris/ui";
import { serverMetricsAction } from "./actions";
import type { ServerConsumer, ServerMetrics } from "@/lib/server-probe";

export function ServerUsage({ hostId }: { hostId: string }) {
    const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
    const [failed, setFailed] = useState(false);

    // Keyed by host upstream, so switching servers remounts this rather than
    // showing the previous machine's numbers while the next one is read.
    useEffect(() => {
        let live = true;
        void serverMetricsAction(hostId).then((result) => {
            if (!live) return;
            if (result) setMetrics(result);
            else setFailed(true);
        });
        return () => {
            live = false;
        };
    }, [hostId]);

    if (failed) {
        return (
            <p className="text-xs text-muted-foreground">
                Polaris could not read this server just now. It may be off or unreachable.
            </p>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="grid grid-cols-3 gap-2">
                <Meter label="CPU" value={cpuLoad(metrics)} caption={cpuCaption(metrics)} />
                <Meter
                    label="Memory"
                    value={ratio(metrics?.memoryUsedBytes, metrics?.memoryTotalBytes)}
                    caption={sizeCaption(metrics?.memoryUsedBytes, metrics?.memoryTotalBytes)}
                />
                <Meter
                    label="Disk"
                    value={ratio(metrics?.diskUsedBytes, metrics?.diskTotalBytes)}
                    caption={sizeCaption(metrics?.diskUsedBytes, metrics?.diskTotalBytes)}
                />
            </div>

            <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Using the most</span>
                {metrics ? (
                    metrics.consumers.length > 0 ? (
                        metrics.consumers.map((consumer) => (
                            <ConsumerRow key={`${consumer.kind}-${consumer.name}`} consumer={consumer} />
                        ))
                    ) : (
                        <span className="text-xs text-muted-foreground">
                            Nothing worth reporting is running on this server.
                        </span>
                    )
                ) : (
                    // Three rows' worth, so the dialog does not resize under the
                    // pointer when the real list lands.
                    <>
                        <Skeleton className="h-6 w-full" />
                        <Skeleton className="h-6 w-full" />
                        <Skeleton className="h-6 w-full" />
                    </>
                )}
            </div>
        </div>
    );
}

function ConsumerRow({ consumer }: { consumer: ServerConsumer }) {
    return (
        <div className="flex items-center gap-2 text-xs">
            {consumer.kind === "container" ? (
                <Box className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
                <Cpu className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="w-full max-w-0 flex-1 truncate" title={consumer.name}>
                {consumer.name}
            </span>
            {consumer.kind === "container" ? <Badge variant="neutral">Container</Badge> : null}
            <span className="tabular-nums text-muted-foreground">
                {consumer.cpuPercent === null ? "-" : `${consumer.cpuPercent.toFixed(1)}%`}
            </span>
            <span className="w-16 text-right tabular-nums text-muted-foreground">{size(consumer.memoryBytes)}</span>
        </div>
    );
}

function Meter({ label, value, caption }: { label: string; value: number | null; caption: string | null }) {
    return (
        <div className="flex flex-col gap-1 rounded-md bg-muted/40 px-2 py-1.5">
            <span className="text-xs text-muted-foreground">{label}</span>
            <div className="h-1.5 overflow-hidden rounded-full bg-border">
                {value === null ? null : (
                    <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
                    />
                )}
            </div>
            {caption === null ? (
                <Skeleton className="h-3 w-16" />
            ) : (
                <span className="text-xs tabular-nums">{caption}</span>
            )}
        </div>
    );
}

/** Load per core, which is the figure that means the same thing on a 2-core box
 *  and a 64-core one. Above 1 the machine is asking for more than it has. */
function cpuLoad(metrics: ServerMetrics | null): number | null {
    if (!metrics || metrics.loadAverage === null || !metrics.cpuCount) return null;
    return metrics.loadAverage / metrics.cpuCount;
}

function cpuCaption(metrics: ServerMetrics | null): string | null {
    if (!metrics) return null;
    if (metrics.loadAverage === null) return "unknown";
    const cores = metrics.cpuCount ? ` of ${metrics.cpuCount}` : "";
    return `${metrics.loadAverage.toFixed(2)} load${cores}`;
}

function ratio(used: number | null | undefined, total: number | null | undefined): number | null {
    if (used === null || used === undefined || !total) return null;
    return used / total;
}

function sizeCaption(used: number | null | undefined, total: number | null | undefined): string | null {
    if (used === undefined || total === undefined) return null;
    if (used === null || total === null) return "unknown";
    return `${size(used)} of ${size(total)}`;
}

const SCALE = ["B", "KB", "MB", "GB", "TB"];

/** Bytes at the scale a person reads them in. Not `toLocaleString`: units and
 *  formats are resolved from the operator's display preferences elsewhere, and a
 *  panel is not the place to start a second convention. */
function size(bytes: number | null): string {
    if (bytes === null) return "-";
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < SCALE.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${SCALE[unit]}`;
}
