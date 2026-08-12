"use client";

/**
 * The cards about what Polaris is running: services, the load on the machines
 * under them, the alarms watching both, and how full the storage is.
 *
 * They share a file because they share a source - one read on the server fills
 * all four (see overview-service) - and a shape: a figure worth reading at a
 * glance, then the handful of rows behind it. None of them is a substitute for
 * the screen it links to; a card that tried to be would be a worse copy of it.
 */

import Link from "next/link";
import { Skeleton, cn } from "@polaris/ui";
import { formatBytes } from "@polaris/core";
import { RelativeTime } from "@/components/relative-time";
import { StateDot, WidgetEmpty, WidgetList, WidgetRow, WidgetRowsSkeleton, WidgetUnavailable } from "../widget-card";
import type {
    OverviewAlarms,
    OverviewServices,
    OverviewStorageEntry,
    OverviewTasks,
    OverviewUsageEntry
} from "@/lib/overview/overview-service";

/** Undefined while the read is in flight, null when it failed. */
export type Loaded<T> = T | null | undefined;

/** Tone by load rather than by state: a service that is up and pinned at 98% is
 *  the one worth looking at, and must not read like an idle one. */
function loadTone(percent: number | null): string {
    if (percent == null) return "text-muted-foreground";
    if (percent >= 90) return "text-danger";
    if (percent >= 70) return "text-warning";
    return "text-foreground";
}

function barTone(percent: number | null): string {
    if (percent == null) return "bg-muted-foreground/40";
    if (percent >= 90) return "bg-danger";
    if (percent >= 75) return "bg-warning";
    return "bg-primary";
}

export function ServicesWidget({ data }: { data: Loaded<OverviewServices> }) {
    if (data === undefined) return <WidgetRowsSkeleton />;
    if (data === null) return <WidgetUnavailable>Deployments could not be read just now.</WidgetUnavailable>;
    if (data.total === 0) {
        return (
            <WidgetEmpty
                action={
                    <Link href="/apps/deploy" className="text-xs font-medium text-primary hover:underline">
                        Deploy something
                    </Link>
                }
            >
                Nothing is deployed yet.
            </WidgetEmpty>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm">
                <span className={cn("text-xl font-semibold", data.running < data.total && "text-warning")}>
                    {data.running}
                </span>
                <span className="text-muted-foreground">
                    {" "}
                    of {data.total} service{data.total === 1 ? "" : "s"} running
                </span>
            </p>
            <WidgetList>
                {data.rows.map((row) => (
                    <WidgetRow
                        key={row.id}
                        href={row.href}
                        icon={<StateDot state={row.state} label={row.stateLabel} />}
                        label={row.label}
                        detail={row.detail}
                    />
                ))}
            </WidgetList>
        </div>
    );
}

/**
 * A filled line over the card's own width, with gaps left as gaps: a flat line
 * drawn through an outage is a lie about the one thing this card exists to show.
 */
function Sparkline({ values, tone }: { values: (number | null)[]; tone: string }) {
    const present = values.filter((value): value is number => value != null);
    if (present.length < 2) return <div className="h-6" />;

    const max = Math.max(10, ...present);
    const step = 100 / Math.max(1, values.length - 1);
    const runs: string[] = [];
    let current: string[] = [];
    values.forEach((value, index) => {
        if (value == null) {
            if (current.length > 1) runs.push(current.join(" "));
            current = [];
            return;
        }
        current.push(`${current.length === 0 ? "M" : "L"} ${(index * step).toFixed(2)} ${(100 - (value / max) * 100).toFixed(2)}`);
    });
    if (current.length > 1) runs.push(current.join(" "));

    return (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-6 w-full" aria-hidden="true">
            {runs.map((path, index) => (
                <path
                    key={index}
                    d={path}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={tone}
                />
            ))}
        </svg>
    );
}

export function UsageWidget({ data }: { data: Loaded<OverviewUsageEntry[]> }) {
    if (data === undefined) return <WidgetRowsSkeleton rows={2} />;
    if (data === null) return <WidgetUnavailable>Usage could not be read just now.</WidgetUnavailable>;
    if (data.length === 0) return <WidgetEmpty>No machine has been sampled yet.</WidgetEmpty>;

    return (
        <ul className="flex flex-col gap-3">
            {data.map((server) => (
                <li key={server.id} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2">
                        <Link href={server.href} className="min-w-0 truncate text-sm hover:underline">
                            {server.name}
                        </Link>
                        <span className={cn("shrink-0 text-sm font-semibold tabular-nums", loadTone(server.cpuPercent))}>
                            {server.cpuPercent == null ? "-" : `${Math.round(server.cpuPercent)}%`}
                        </span>
                    </div>
                    <Sparkline values={server.spark} tone={loadTone(server.cpuPercent)} />
                    <p className="text-xs text-muted-foreground">
                        {server.memUsedBytes == null
                            ? "Memory not reported"
                            : `${formatBytes(server.memUsedBytes)}${
                                  server.memTotalBytes == null ? "" : ` / ${formatBytes(server.memTotalBytes)}`
                              } memory`}
                    </p>
                </li>
            ))}
        </ul>
    );
}

export function AlarmsWidget({ data }: { data: Loaded<OverviewAlarms> }) {
    if (data === undefined) return <WidgetRowsSkeleton rows={2} />;
    if (data === null) return <WidgetUnavailable>Alarms could not be read just now.</WidgetUnavailable>;
    if (data.firing === 0 && data.events.length === 0) {
        return (
            <WidgetEmpty
                action={
                    <Link href="/watch/alarms" className="text-xs font-medium text-primary hover:underline">
                        Set one up
                    </Link>
                }
            >
                Nothing has tripped. No alarms yet either.
            </WidgetEmpty>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm">
                <span className={cn("text-xl font-semibold", data.firing > 0 && "text-danger")}>{data.firing}</span>
                <span className="text-muted-foreground"> firing now</span>
            </p>
            {data.events.length > 0 ? (
                <ul className="flex flex-col gap-2">
                    {data.events.map((event) => (
                        <li key={event.id} className="flex items-start gap-2">
                            <StateDot
                                state={event.kind === "resolved" ? "up" : "down"}
                                label={event.kind === "resolved" ? "Resolved" : "Triggered"}
                            />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-sm" title={event.name}>{event.name}</span>
                                <span className="truncate text-xs text-muted-foreground">
                                    {event.kind === "resolved" ? "Resolved" : "Triggered"}
                                    {event.detail ? ` - ${event.detail}` : ""} <RelativeTime iso={event.createdAt} />
                                </span>
                            </span>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

export function StorageWidget({ data }: { data: Loaded<OverviewStorageEntry[]> }) {
    if (data === undefined) return <WidgetRowsSkeleton rows={2} />;
    if (data === null) return <WidgetUnavailable>Storage could not be read just now.</WidgetUnavailable>;
    if (data.length === 0) {
        return (
            <WidgetEmpty
                action={
                    <Link href="/drive/overview" className="text-xs font-medium text-primary hover:underline">
                        Connect a device
                    </Link>
                }
            >
                No device has reported its usage yet.
            </WidgetEmpty>
        );
    }

    return (
        <ul className="flex flex-col gap-3">
            {data.map((device) => {
                const percent =
                    device.usedBytes == null || !device.totalBytes
                        ? null
                        : Math.min(100, Math.round((device.usedBytes / device.totalBytes) * 100));
                return (
                    <li key={device.id} className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between gap-2">
                            <Link href={device.href} className="min-w-0 truncate text-sm hover:underline">
                                {device.name}
                            </Link>
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                {percent == null ? "-" : `${percent}%`}
                            </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                                className={cn("h-full rounded-full transition-all", barTone(percent))}
                                style={{ width: `${percent ?? 0}%` }}
                            />
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {device.usedBytes == null ? "Usage not reported" : formatBytes(device.usedBytes)}
                            {device.totalBytes == null ? "" : ` of ${formatBytes(device.totalBytes)}`}
                        </p>
                    </li>
                );
            })}
        </ul>
    );
}

/** Assigned work, as the three numbers somebody actually asks about. */
export function TasksWidget({ data }: { data: Loaded<OverviewTasks> }) {
    if (data === undefined) {
        return (
            <div className="grid grid-cols-3 gap-2" aria-busy="true">
                {Array.from({ length: 3 }, (_, index) => (
                    <Skeleton key={index} className="h-16 rounded-md" />
                ))}
            </div>
        );
    }
    if (data === null) return <WidgetUnavailable>Your work could not be read just now.</WidgetUnavailable>;
    if (data.assigned === 0) return <WidgetEmpty>Nothing is assigned to you.</WidgetEmpty>;

    const tiles = [
        { label: "Assigned", value: data.assigned, tone: "text-foreground", href: "/tasks" },
        { label: "Due today", value: data.dueToday, tone: data.dueToday > 0 ? "text-warning" : "text-foreground", href: "/tasks" },
        { label: "Overdue", value: data.overdue, tone: data.overdue > 0 ? "text-danger" : "text-foreground", href: "/tasks" }
    ];

    return (
        <div className="grid grid-cols-3 gap-2">
            {tiles.map((tile) => (
                <Link
                    key={tile.label}
                    href={tile.href}
                    className="flex flex-col items-center gap-0.5 rounded-md border border-border/60 px-2 py-3 transition-colors hover:border-primary hover:bg-primary/5"
                >
                    <span className={cn("text-xl font-semibold tabular-nums", tile.tone)}>{tile.value}</span>
                    <span className="text-center text-xs text-muted-foreground">{tile.label}</span>
                </Link>
            ))}
        </div>
    );
}
