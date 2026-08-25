"use client";

/**
 * Where the machine went.
 *
 * The split at the top is the whole point of the screen: one bar of the machine's
 * memory, divided into Polaris, the apps somebody installed, the services deployed
 * here, and whatever else is running - so the answer to "what is using this box"
 * is a glance rather than an addition. The tables under it are the same figures
 * broken down, heaviest first, because the next question is always which one.
 *
 * Polaris' own row is not a table here. Its parts, and what they occupy on disk,
 * come from the footprint endpoint (which measures volumes and is an order of
 * magnitude slower), so the card that already draws them is used as it is.
 *
 * Nothing on this screen waits for the engine: the chrome paints, the figures land
 * after, and a revisit shows the previous reading while the fresh one is on its
 * way.
 */

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { useLiveResource } from "@/components/use-live-resource";
import { formatAge } from "@/app/(app)/apps/containers/freshness";
import { PolarisFootprintCard } from "@/app/(app)/apps/containers/polaris-footprint";
import { Badge, Button, Card, CardBody, cn, EmptyState, PageHeader, Skeleton } from "@polaris/ui";
import { consumedMemBytes, type Consumption, type ConsumptionGroup, type ConsumptionRow } from "./types";

/** The readings come from the sampler every other screen shares, which takes a
 *  pass a minute. Polling faster than that would redraw the same numbers. */
const POLL_MS = 30_000;

/** What each group is painted in. Deliberately not the warning and danger tones:
 *  a container Polaris did not start is not a problem, and colouring it like one
 *  would say it is. */
const TONE: Record<ConsumptionGroup["id"], string> = {
    polaris: "bg-primary",
    apps: "bg-accent",
    services: "bg-success",
    other: "bg-foreground-subtle"
};

export function ConsumptionView() {
    const { data, loading, error, stale, refreshing, refresh } = useLiveResource<Consumption>({
        url: "/api/admin/consumption",
        cacheKey: "admin.consumption",
        intervalMs: POLL_MS,
        select: (body) => body as Consumption
    });

    return (
        <>
            <PageHeader
                title="Consumption"
                description="What the machine Polaris runs on is being spent on: the control plane itself, the apps installed on it, and everything else."
                actions={
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={refresh}
                        disabled={refreshing}
                        aria-label="Refresh"
                        title="Refresh"
                    >
                        <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
                    </Button>
                }
            />

            {error ? (
                <EmptyState
                    title="Nothing to measure"
                    description={`Polaris could not read what this machine is using. ${error}`}
                />
            ) : (
                <div className="flex flex-col gap-4">
                    {stale ? <p className="text-sm text-warning">{stale}</p> : null}
                    <ConsumptionSplit consumption={data} loading={loading} />
                    <PolarisFootprintCard />
                    {(data?.groups ?? []).map((group) =>
                        group.id === "polaris" ? null : (
                            <ConsumptionGroupTable key={group.id} group={group} loading={loading} />
                        )
                    )}
                    {loading && !data
                        ? [0, 1, 2].map((row) => <Skeleton key={row} className="h-40 w-full" />)
                        : null}
                </div>
            )}
        </>
    );
}

/** The machine as one bar. What is left over is not called free: the host's own
 *  processes are outside every container measured here, so the remainder is
 *  everything this screen cannot see plus whatever is genuinely unused. */
export function ConsumptionSplit({
    consumption,
    loading
}: {
    consumption: Consumption | null;
    loading: boolean;
}) {
    if (!consumption) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-3">
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-4 w-80" />
                </CardBody>
            </Card>
        );
    }

    const total = consumption.machine.memTotalBytes;
    const used = consumedMemBytes(consumption);
    const groups = consumption.groups;

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{consumption.machine.name}</span>
                    <span className="text-xs text-muted-foreground">
                        {total ? `${formatBytes(used)} of ${formatBytes(total)} in containers` : formatBytes(used)}
                        {consumption.machine.ncpu > 0
                            ? ` - ${consumption.machine.ncpu} core${consumption.machine.ncpu === 1 ? "" : "s"}`
                            : ""}
                        {consumption.sampledAt === null
                            ? " - measuring"
                            : ` - measured ${formatAge(Date.now() - consumption.sampledAt)} ago`}
                    </span>
                </div>

                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-border" role="presentation">
                    {groups.map((group) => {
                        const share = total ? (group.memUsedBytes / total) * 100 : 0;
                        if (share <= 0) return null;
                        return (
                            <span
                                key={group.id}
                                className={cn("h-full", TONE[group.id])}
                                style={{ width: `${Math.max(0.5, share)}%` }}
                                title={`${group.label}: ${formatBytes(group.memUsedBytes)}`}
                            />
                        );
                    })}
                </div>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                    {groups.map((group) => (
                        <div key={group.id} className="flex min-w-0 flex-col gap-0.5">
                            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <span className={cn("size-2 shrink-0 rounded-full", TONE[group.id])} />
                                <span className="truncate" title={group.label}>{group.label}</span>
                            </dt>
                            <dd className="text-sm font-medium tabular-nums">
                                {formatBytes(group.memUsedBytes)}
                                <span className="ml-1.5 text-xs font-normal text-muted-foreground tabular-nums">
                                    {group.cpuPercent}% CPU
                                </span>
                            </dd>
                            <dd className="text-xs text-foreground-subtle">
                                {group.containers} container{group.containers === 1 ? "" : "s"}
                            </dd>
                        </div>
                    ))}
                </dl>

                {loading ? null : (
                    <p className="text-xs text-muted-foreground">
                        Only this machine. Memory and CPU are what the containers hold right now; a service
                        counts the releases it keeps and the tunnel publishing it.
                    </p>
                )}
            </CardBody>
        </Card>
    );
}

export function ConsumptionGroupTable({ group, loading }: { group: ConsumptionGroup; loading: boolean }) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-2 text-sm font-medium">
                            <span className={cn("size-2 shrink-0 rounded-full", TONE[group.id])} />
                            {group.label}
                        </span>
                        <span className="text-xs text-muted-foreground">{group.description}</span>
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">
                        {formatBytes(group.memUsedBytes)} - {group.cpuPercent}% CPU
                    </span>
                </div>

                {group.rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {loading ? "Reading the machine." : emptyLine(group.id)}
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[34rem] text-sm">
                            <thead>
                                <tr className="text-left">
                                    <th className="w-full max-w-0 py-1 pr-3">Name</th>
                                    <th className="py-1 pr-3">Owner</th>
                                    <th className="py-1 pr-3 text-right">CPU</th>
                                    <th className="py-1 text-right">Memory</th>
                                </tr>
                            </thead>
                            <tbody>
                                {group.rows.map((row) => (
                                    <Row key={row.id} row={row} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}

function emptyLine(id: ConsumptionGroup["id"]): string {
    if (id === "apps") return "Nothing installed from the marketplace yet.";
    if (id === "services") return "Nothing deployed here yet.";
    return "Nothing else is running on this machine.";
}

function Row({ row }: { row: ConsumptionRow }) {
    const name = row.href ? (
        <Link href={row.href} className="font-medium hover:text-primary hover:underline">
            {row.name}
        </Link>
    ) : (
        <span className="font-medium">{row.name}</span>
    );

    return (
        <tr className="border-t border-border align-top">
            <td className="w-full max-w-0 py-2 pr-3">
                <div className="flex items-center gap-2">
                    <span className="truncate" title={row.name}>
                        {name}
                    </span>
                    {row.state === "running" ? null : (
                        <Badge variant={row.state === "stopped" ? "neutral" : "warning"}>{row.stateLabel}</Badge>
                    )}
                </div>
                <div className="truncate text-xs text-muted-foreground" title={row.detail}>
                    {row.detail}
                    {row.containers > 1 ? ` - ${row.containers} containers` : ""}
                </div>
            </td>
            <td className="py-2 pr-3 text-xs text-muted-foreground">{row.owner ?? "-"}</td>
            <td className="py-2 pr-3 text-right text-muted-foreground tabular-nums">
                {row.cpuPercent === null ? "-" : `${row.cpuPercent}%`}
            </td>
            <td className="py-2 text-right text-muted-foreground tabular-nums">
                {row.memUsedBytes === null ? "-" : formatBytes(row.memUsedBytes)}
            </td>
        </tr>
    );
}
