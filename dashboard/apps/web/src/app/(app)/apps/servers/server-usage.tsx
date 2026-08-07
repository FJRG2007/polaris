"use client";

/**
 * Where a server's CPU, memory and disk went, and what is holding them.
 *
 * The panel paints before the machine answers, from the last reading this tab
 * took of it: reading this costs an SSH session to somebody's box, and a screen
 * of skeletons that resolve a second or two later is the shape of a page that
 * looks broken every time it is opened. The live answer replaces it as soon as it
 * lands, and the figures keep refreshing while the page is open, so what is on
 * screen is what the machine is doing rather than what it was doing when it was
 * opened. A reading that has aged says so instead of passing for this instant's.
 *
 * Containers and processes are ranked together on purpose. The question behind
 * "what is eating this machine" is never "which of these two kinds is it".
 */

import { useCallback } from "react";
import { Box, Cpu } from "lucide-react";
import { Badge, Skeleton } from "@polaris/ui";
import { serverMetricsAction } from "./actions";
import { useLiveRead } from "@/components/use-live-resource";
import { formatAge } from "@/app/(app)/apps/containers/freshness";
import type { ServerConsumer, ServerMetrics } from "@/lib/server-probe";

/** The cadence the probe itself is cached at on the server, so a poll is one SSH
 *  session per interval rather than one per tick that answers with the same
 *  numbers. The rest of the page polls at this rate too. */
const REFRESH_MS = 30_000;

/** Past this - two cadences - the readings have stopped arriving rather than
 *  being between polls, which is worth saying on a monitoring panel. */
const STALE_AFTER_MS = 2 * REFRESH_MS;

export function ServerUsage({ hostId }: { hostId: string }) {
    // A machine that cannot be read has to throw rather than resolve empty: the
    // difference between "unreachable" and "nothing running" is the whole point
    // of the panel, and it decides whether the last reading stays on screen.
    const load = useCallback(async (): Promise<ServerMetrics> => {
        const result = await serverMetricsAction(hostId);
        if (!result) throw new Error("It may be off or unreachable.");
        return result;
    }, [hostId]);

    const {
        data: metrics,
        error,
        stale,
        updatedAt
    } = useLiveRead<ServerMetrics>({
        load,
        // Per host, so switching servers paints that machine's last reading
        // rather than the previous one's numbers under this one's name.
        cacheKey: `servers.usage.${hostId}`,
        intervalMs: REFRESH_MS
    });

    if (error) {
        return (
            <p className="text-xs text-muted-foreground">
                Polaris could not read this server just now. {error}
            </p>
        );
    }

    const age = updatedAt === null ? null : Date.now() - updatedAt;

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
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                        Heaviest on the machine
                    </span>
                    {/* A refresh that failed over figures still on screen, or a
                        reading old enough that it is no longer this instant's. */}
                    {stale ? (
                        <span className="text-xs text-warning">Not answering. {stale}</span>
                    ) : age !== null && age > STALE_AFTER_MS ? (
                        <span className="text-xs text-muted-foreground">
                            read {formatAge(age)} ago
                        </span>
                    ) : null}
                </div>
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
                    // Three rows' worth, so nothing below shifts under the pointer
                    // when the real list lands. Only ever seen on a machine this
                    // tab has not read before.
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
