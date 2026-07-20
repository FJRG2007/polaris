"use client";

/**
 * Containers view: a host overview (CPU/memory/counts) and a live table of
 * containers with lifecycle controls. Stats are refreshed on an interval by
 * re-fetching the server component, so a single code path renders both the
 * initial and the updated data. Actions call the server actions, which re-check
 * permission before touching Docker.
 */

import { useEffect, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Boxes, Cpu, MemoryStick, Play, RefreshCw, RotateCw, Server, Square, Trash2 } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Badge, Button, Card, CardBody, cn } from "@polaris/ui";
import { containerAction, deleteDockerConnectionAction } from "./actions";
import { DockerConnectionDialog } from "./docker-connection-dialog";
import type { ContainerRow, DockerConnectionSummary, OverviewData } from "./types";

const REFRESH_MS = 5000;

export function ContainersView({
    connections,
    connectionId,
    sshEnabled,
    overview,
    containers,
    error
}: {
    connections: DockerConnectionSummary[];
    connectionId: string | null;
    sshEnabled: boolean;
    overview: OverviewData | null;
    containers: ContainerRow[];
    error: string | null;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [live, setLive] = useState(true);

    // Poll for fresh stats by re-rendering the server component.
    useEffect(() => {
        if (!live || !connectionId) return;
        const timer = setInterval(() => router.refresh(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [live, connectionId, router]);

    function onAction(containerId: string, action: "start" | "stop" | "restart") {
        startTransition(async () => {
            await containerAction(connectionId!, containerId, action);
            router.refresh();
        });
    }

    function onDeleteConnection(id: string) {
        if (!window.confirm("Remove this Docker connection?")) return;
        startTransition(async () => {
            await deleteDockerConnectionAction(id);
            router.refresh();
        });
    }

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
            <aside className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-medium text-muted-foreground">Docker hosts</h2>
                    <DockerConnectionDialog sshEnabled={sshEnabled} />
                </div>
                <nav className="flex flex-col gap-1">
                    {connections.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No hosts yet.</p>
                    ) : (
                        connections.map((connection) => (
                            <div key={connection.id} className="group flex items-center gap-1">
                                <Link
                                    href={`/apps/containers?c=${connection.id}`}
                                    className={cn(
                                        "flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted",
                                        connection.id === connectionId && "bg-muted font-medium"
                                    )}
                                >
                                    <Server className="size-4 text-muted-foreground" />
                                    <span className="flex-1 truncate">{connection.name}</span>
                                    <Badge variant="neutral">{connection.local ? "local" : connection.transport}</Badge>
                                </Link>
                                {connection.local ? null : (
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => onDeleteConnection(connection.id)}
                                        aria-label={`Remove ${connection.name}`}
                                        className="opacity-0 group-hover:opacity-100"
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                )}
                            </div>
                        ))
                    )}
                </nav>
            </aside>

            <section className="min-w-0">
                {!connectionId ? (
                    <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        Connect a Docker host to monitor and manage containers.
                        <span className="mt-2 block">
                            The local host appears here automatically in the full edition. Use Add host for a
                            remote engine.
                        </span>
                    </div>
                ) : error ? (
                    <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                        {error}
                    </div>
                ) : (
                    <>
                        {overview ? (
                            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                                <Stat icon={<Boxes className="size-4" />} label="Containers" value={`${overview.running}/${overview.containers}`} hint="running / total" />
                                <Stat icon={<Cpu className="size-4" />} label="CPU (containers)" value={`${overview.aggregateCpuPercent}%`} hint={`${overview.ncpu} cores`} />
                                <Stat icon={<MemoryStick className="size-4" />} label="Memory (containers)" value={formatBytes(overview.aggregateMemUsage)} hint={`of ${formatBytes(overview.memTotal)}`} />
                                <Stat icon={<Server className="size-4" />} label="Engine" value={overview.serverVersion || overview.name} hint={overview.name} />
                            </div>
                        ) : null}

                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">
                                {live ? "Live - refreshing every 5s" : "Paused"}
                            </span>
                            <div className="flex items-center gap-2">
                                <Button size="sm" variant="ghost" onClick={() => setLive((value) => !value)}>
                                    {live ? "Pause" : "Resume"}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => router.refresh()} disabled={pending}>
                                    <RefreshCw className="size-4" />
                                    Refresh
                                </Button>
                            </div>
                        </div>

                        <div className="overflow-hidden rounded-lg border border-border">
                            <table className="w-full text-sm">
                                <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                                    <tr>
                                        <th className="px-3 py-2 font-medium">Container</th>
                                        <th className="px-3 py-2 font-medium">State</th>
                                        <th className="px-3 py-2 font-medium">CPU</th>
                                        <th className="px-3 py-2 font-medium">Memory</th>
                                        <th className="px-3 py-2" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {containers.length === 0 ? (
                                        <tr>
                                            <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                                                No containers on this host.
                                            </td>
                                        </tr>
                                    ) : (
                                        containers.map((container) => (
                                            <tr key={container.id} className="border-t border-border hover:bg-card-hover">
                                                <td className="px-3 py-2">
                                                    <span className="block font-medium">{container.name}</span>
                                                    <span className="block truncate text-xs text-muted-foreground">
                                                        {container.image}
                                                    </span>
                                                </td>
                                                <td className="px-3 py-2">
                                                    <Badge variant={container.state === "running" ? "success" : "neutral"}>
                                                        {container.state}
                                                    </Badge>
                                                </td>
                                                <td className="px-3 py-2 text-muted-foreground">
                                                    {container.cpuPercent === null ? "-" : `${container.cpuPercent}%`}
                                                </td>
                                                <td className="px-3 py-2 text-muted-foreground">
                                                    {container.memUsage === null ? "-" : formatBytes(container.memUsage)}
                                                </td>
                                                <td className="px-3 py-2">
                                                    <div className="flex justify-end gap-1">
                                                        {container.state === "running" ? (
                                                            <>
                                                                <IconButton label="Restart" onClick={() => onAction(container.id, "restart")} disabled={pending}>
                                                                    <RotateCw className="size-4" />
                                                                </IconButton>
                                                                <IconButton label="Stop" onClick={() => onAction(container.id, "stop")} disabled={pending}>
                                                                    <Square className="size-4" />
                                                                </IconButton>
                                                            </>
                                                        ) : (
                                                            <IconButton label="Start" onClick={() => onAction(container.id, "start")} disabled={pending}>
                                                                <Play className="size-4" />
                                                            </IconButton>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </section>
        </div>
    );
}

function Stat({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) {
    return (
        <Card>
            <CardBody className="p-3">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    {icon}
                    {label}
                </div>
                <div className="truncate text-lg font-semibold">{value}</div>
                <div className="truncate text-xs text-muted-foreground">{hint}</div>
            </CardBody>
        </Card>
    );
}

function IconButton({
    label,
    onClick,
    disabled,
    children
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    children: ReactNode;
}) {
    return (
        <Button size="icon" variant="ghost" onClick={onClick} disabled={disabled} aria-label={label} title={label}>
            {children}
        </Button>
    );
}
