"use client";

/**
 * What this server is actually running, heaviest first.
 *
 * The figures come from the sampler the Containers app and the metrics collector
 * share, so this costs a listing rather than a stats read per container - and a
 * server opened from the table has its numbers straight away instead of a screen
 * of skeletons that resolve a second later. A reading that has aged says so rather
 * than passing for this instant's.
 *
 * Every row is a link, because the next thing anybody wants after "this one is
 * eating the machine" is that container's logs.
 */

import Link from "next/link";
import { Box } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Badge, Button, Skeleton, cn } from "@polaris/ui";
import { useLiveResource } from "@/components/use-live-resource";
import { formatAge, STALE_AFTER_MS } from "@/app/(app)/apps/containers/freshness";
import type { ContainerRow, HostSnapshot } from "@/app/(app)/apps/containers/types";

/** The same cadence the Containers table polls at: this is the same data, and a
 *  server's page is no less live than the list it was opened from. */
const REFRESH_MS = 5000;

/** Enough to see where a machine's load went without turning the page into the
 *  Containers table, which is one click away and does that better. */
const SHOWN = 8;

export function ServerWorkload({ connectionId }: { connectionId: string }) {
    const { data, loading, error, stale } = useLiveResource<HostSnapshot>({
        url: `/api/containers?c=${encodeURIComponent(connectionId)}`,
        // The key the Containers table writes, so opening a server after visiting
        // that host paints from what it already fetched.
        cacheKey: `containers.${connectionId}`,
        intervalMs: REFRESH_MS,
        select: (body) => body as HostSnapshot
    });

    const containers = [...(data?.containers ?? [])].sort(byWeight);
    const running = containers.filter((container) => container.state === "running");
    const age = data?.statsAt ? Date.now() - data.statsAt : null;

    return (
        <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-medium">
                    Using the most
                    {data ? (
                        <span className="ml-1.5 text-muted-foreground">
                            {running.length} of {containers.length} running
                        </span>
                    ) : null}
                </h2>
                {/* A refresh that failed over figures still on screen. A panel that
                    quietly keeps showing a healthy machine that has since stopped
                    answering is worse than one that says so. */}
                {stale ? (
                    <span className="text-xs text-warning">{stale}</span>
                ) : age !== null && age > STALE_AFTER_MS ? (
                    <span className="text-xs text-muted-foreground">sampled {formatAge(age)} ago</span>
                ) : null}
            </div>

            {loading ? (
                <div className="flex flex-col gap-1">
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                </div>
            ) : error ? (
                <p className="text-xs text-muted-foreground">
                    Polaris could not reach the container engine on this server: {error}
                </p>
            ) : containers.length === 0 ? (
                <p className="text-xs text-muted-foreground">No containers on this server.</p>
            ) : (
                <>
                    <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-md border border-border">
                        {containers.slice(0, SHOWN).map((container) => (
                            <ContainerLine
                                key={container.id}
                                container={container}
                                connectionId={connectionId}
                                memTotal={data?.overview.memTotal ?? null}
                            />
                        ))}
                    </ul>
                    <div className="flex items-center justify-between gap-2">
                        {containers.length > SHOWN ? (
                            <span className="text-xs text-muted-foreground">
                                and {containers.length - SHOWN} more
                            </span>
                        ) : (
                            <span />
                        )}
                        <Button asChild variant="ghost" size="sm">
                            <Link href={`/apps/containers?c=${encodeURIComponent(connectionId)}`}>
                                Open in Containers
                            </Link>
                        </Button>
                    </div>
                </>
            )}
        </section>
    );
}

/** Heaviest first: CPU decides, memory breaks the tie, and anything not running
 *  sinks below everything that is - it is costing the machine nothing. */
function byWeight(a: ContainerRow, b: ContainerRow): number {
    const stopped = Number(b.state === "running") - Number(a.state === "running");
    if (stopped !== 0) return stopped;
    return (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0) || (b.memUsage ?? 0) - (a.memUsage ?? 0);
}

function ContainerLine({
    container,
    connectionId,
    memTotal
}: {
    container: ContainerRow;
    connectionId: string;
    /** What the machine has, so a container's memory reads as a share of it. */
    memTotal: number | null;
}) {
    const share = memTotal && container.memUsage !== null ? container.memUsage / memTotal : null;
    return (
        <li>
            <Link
                href={`/apps/containers/${encodeURIComponent(container.name)}?c=${encodeURIComponent(connectionId)}`}
                className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-card-hover"
            >
                <Box className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium" title={container.name}>
                        {container.name}
                    </span>
                    <span className="truncate text-muted-foreground" title={container.image}>
                        {container.image}
                    </span>
                </span>
                {container.state === "running" ? null : <Badge variant="neutral">{container.state}</Badge>}
                <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                    {container.cpuPercent === null ? "-" : `${container.cpuPercent}%`}
                </span>
                <span className="flex w-24 shrink-0 flex-col items-end gap-1">
                    <span className="tabular-nums text-muted-foreground">
                        {container.memUsage === null ? "-" : formatBytes(container.memUsage)}
                    </span>
                    {/* The bar is the only thing here that says "of the machine".
                        Without it a container using 400 MB reads the same on a
                        1 GB box and a 64 GB one. */}
                    <span className={cn("h-1 w-full overflow-hidden rounded-full bg-border", share === null && "opacity-0")}>
                        <span
                            className="block h-full rounded-full bg-primary"
                            style={{ width: `${Math.min(100, Math.max(1, (share ?? 0) * 100))}%` }}
                        />
                    </span>
                </span>
            </Link>
        </li>
    );
}
