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
import { cn } from "@polaris/ui";
import { formatBytes } from "@polaris/core";
import { GameLogo } from "@/components/game-picker";
import { findGame } from "@/lib/apps/games-catalog";
import { PriorityMark } from "@/components/priority-mark";
import { RelativeTime } from "@/components/relative-time";
import { StateDot, WidgetEmpty, WidgetList, WidgetRow, WidgetRowsSkeleton, WidgetUnavailable } from "../widget-card";
import type {
    OverviewAlarms,
    OverviewGames,
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

/**
 * The game servers this account runs.
 *
 * Meant to be up, not proven to be answering: proving it costs a command inside
 * every running container, which is the games screen's business and not a landing
 * screen's. The card says how many are meant to be running and which ones are
 * not, and the row goes to the server whose state you just read.
 */
export function GamesWidget({ data }: { data: Loaded<OverviewGames> }) {
    if (data === undefined) return <WidgetRowsSkeleton rows={2} />;
    if (data === null) return <WidgetUnavailable>Your game servers could not be read just now.</WidgetUnavailable>;
    if (data.total === 0) {
        return (
            <WidgetEmpty
                action={
                    <Link href="/apps/games" className="text-xs font-medium text-primary hover:underline">
                        Create one
                    </Link>
                }
            >
                No game server yet.
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
                    of {data.total} server{data.total === 1 ? "" : "s"} up
                </span>
            </p>
            <WidgetList>
                {data.servers.map((server) => (
                    <WidgetRow
                        key={server.id}
                        href={server.href}
                        icon={<GameMark game={server.game} running={server.running} />}
                        label={server.name}
                        detail={server.detail || null}
                        trailing={
                            server.slots === null ? undefined : (
                                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                    {server.slots} slots
                                </span>
                            )
                        }
                    />
                ))}
            </WidgetList>
        </div>
    );
}

/** The work assigned to somebody, most pressing first. */
export function TasksWidget({ data }: { data: Loaded<OverviewTasks> }) {
    if (data === undefined) return <WidgetRowsSkeleton />;
    if (data === null) return <WidgetUnavailable>Your work could not be read just now.</WidgetUnavailable>;
    if (data.assigned === 0) return <WidgetEmpty>Nothing is assigned to you.</WidgetEmpty>;

    return (
        <div className="flex flex-col gap-3">
            {/* One line, not three tiles: how much work there is says nothing about
                what it is, and the tasks below are what somebody came to see. */}
            <p className="text-sm">
                <span className="text-xl font-semibold tabular-nums">{data.assigned}</span>
                <span className="text-muted-foreground"> assigned</span>
                {data.overdue > 0 ? <span className="text-danger"> - {data.overdue} overdue</span> : null}
                {data.dueToday > 0 ? <span className="text-warning"> - {data.dueToday} due today</span> : null}
            </p>
            <WidgetList>
                {data.rows.map((task) => (
                    <WidgetRow
                        key={task.id}
                        href={task.href}
                        icon={<PriorityMark priority={task.priority} className="mt-0.5" />}
                        label={task.name}
                        detail={`${task.reference} - ${task.list}`}
                        trailing={
                            task.dueDate ? (
                                <span className={cn("shrink-0 text-xs", task.overdue ? "text-danger" : "text-muted-foreground")}>
                                    <RelativeTime iso={task.dueDate} />
                                </span>
                            ) : null
                        }
                    />
                ))}
            </WidgetList>
        </div>
    );
}

/**
 * A server as its own game's mark, with whether it is up badged on it.
 *
 * The same logo the games table leads with, for the same reason: a list of
 * servers of several games is scanned for "the ARK one" long before it is read.
 * The state rides on the corner rather than replacing it, because both facts are
 * why somebody looked - and a game nothing in the catalogue claims falls back to
 * the plain dot rather than to a gap where a mark should be.
 */
function GameMark({ game, running }: { game: string | null; running: boolean }) {
    const label = running ? "Up" : "Stopped";
    const definition = game ? findGame(game) : undefined;
    if (!definition) return <StateDot state={running ? "up" : "idle"} label={label} />;
    return (
        <span className="relative shrink-0" title={label}>
            <GameLogo game={definition} className="size-6" />
            <span
                className={cn(
                    "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card",
                    running ? "bg-success" : "bg-muted-foreground"
                )}
                aria-label={label}
            />
        </span>
    );
}
