"use client";

/**
 * Containers view: a host overview (CPU/memory/counts) and a live table of
 * containers with lifecycle controls, logs, files, a console and removal.
 *
 * The data is fetched from /api/containers rather than server-rendered, so the
 * host list and the table chrome are on screen before a possibly-remote engine
 * has answered. The same fetch backs the 5s refresh, so first load and live
 * updates run one code path, and the last answer is kept in the tab: coming back
 * to a host paints it as it was before the request leaves. Usage figures carry
 * the moment they were sampled, so a reading that has aged says so instead of
 * passing for this instant's. Actions call the server actions, which re-check
 * permission before touching Docker.
 */

import Link from "next/link";
import { formatBytes } from "@polaris/core";
import { useRouter } from "next/navigation";
import { formatAge, STALE_AFTER_MS } from "./freshness";
import { useConfirm } from "@/components/confirm-dialog";
import { useLiveResource } from "@/components/use-live-resource";
import { DockerConnectionDialog } from "./docker-connection-dialog";
import { Badge, Button, Card, CardBody, Skeleton, cn } from "@polaris/ui";
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";
import { containerAction, deleteDockerConnectionAction, removeContainerAction } from "./actions";
import type {
    ContainerRow,
    DockerConnectionSummary,
    HostSnapshot,
    LocalHostDiagnostic,
    OverviewData
} from "./types";
import {
    Boxes,
    Cpu,
    FileText,
    MemoryStick,
    Play,
    RefreshCw,
    RotateCw,
    ScrollText,
    Server,
    Square,
    TerminalSquare,
    Trash2
} from "lucide-react";

const REFRESH_MS = 5000;

/** Which tab of a container's page a row's action opens. */
type ContainerTab = "details" | "logs" | "files" | "console";

export function ContainersView({
    connections,
    connectionId,
    sshEnabled,
    canManage,
    localDiagnostic
}: {
    connections: DockerConnectionSummary[];
    connectionId: string | null;
    sshEnabled: boolean;
    canManage: boolean;
    localDiagnostic: LocalHostDiagnostic | null;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [live, setLive] = useState(true);
    const [confirm, confirmDialog] = useConfirm();
    // Containers whose removal is in flight. They are already off the table - the
    // engine takes a moment to stop one, and a row that sits there until the next
    // refresh reads as a button that did nothing. A refusal puts the row back.
    const [removing, setRemoving] = useState<string[]>([]);
    // Why an action failed, which is a different thing from the host having
    // stopped answering and must not be wiped by the next successful poll.
    const [actionError, setActionError] = useState<string | null>(null);

    // Seeded from the last answer this tab held for the host, polled while the
    // tab is in front, and folded in so only the numbers that moved re-render.
    const {
        data: snapshot,
        loading,
        error,
        stale,
        refresh: reload
    } = useLiveResource<HostSnapshot>({
        url: connectionId ? `/api/containers?c=${encodeURIComponent(connectionId)}` : "",
        cacheKey: `containers.${connectionId ?? "none"}`,
        intervalMs: REFRESH_MS,
        enabled: connectionId !== null,
        // Pausing stops the refresh, not the load: picking a different host while
        // paused still has to put that host on screen.
        paused: !live,
        select: (body) => body as HostSnapshot
    });

    // A container the engine no longer lists is gone for real, so it no longer
    // needs hiding; one still listed is still on its way out and stays hidden.
    useEffect(() => {
        if (!snapshot) return;
        setRemoving((ids) => ids.filter((id) => snapshot.containers.some((row) => row.id === id)));
    }, [snapshot]);

    const refresh = useCallback(() => {
        if (connectionId) reload();
    }, [connectionId, reload]);

    function onAction(containerId: string, action: "start" | "stop" | "restart") {
        setActionError(null);
        startTransition(async () => {
            const result = await containerAction(connectionId!, containerId, action);
            if (result.error) setActionError(result.error);
            refresh();
        });
    }

    async function onRemoveContainer(container: ContainerRow) {
        const running = container.state === "running";
        const confirmed = await confirm({
            title: `Remove ${container.name}?`,
            description: running
                ? "It is still running, so it will be stopped first. Named volumes and images are left alone."
                : "Named volumes and images are left alone.",
            confirmLabel: "Remove",
            danger: true
        });
        if (!confirmed) return;
        setRemoving((ids) => [...ids, container.id]);
        startTransition(async () => {
            const result = await removeContainerAction(connectionId!, container.id, {
                force: running,
                volumes: false
            });
            if (result.error) {
                setRemoving((ids) => ids.filter((id) => id !== container.id));
                setActionError(result.error);
            }
            refresh();
        });
    }

    async function onDeleteConnection(id: string) {
        if (
            !(await confirm({
                title: "Remove this Docker connection?",
                confirmLabel: "Remove",
                danger: true
            }))
        )
            return;
        startTransition(async () => {
            await deleteDockerConnectionAction(id);
            router.refresh();
        });
    }

    const containers = (snapshot?.containers ?? []).filter(
        (container) => !removing.includes(container.id)
    );
    // Usage is sampled behind the request, so the listing can be answered without
    // waiting for it. Say when what is shown was taken rather than let a reading
    // that has aged pass for this instant's.
    const usageAge = snapshot?.statsAt ? Date.now() - snapshot.statsAt : null;
    const statusLabel = !live
        ? "Paused"
        : loading
          ? "Loading"
          : usageAge === null
            ? "Live - first usage reading on its way"
            : usageAge > STALE_AFTER_MS
              ? `Live - usage from ${formatAge(usageAge)} ago`
              : "Live - refreshing every 5s";

    /** A container's own page, on the host it was listed from. Named rather than
     *  identified: it is what Docker calls it, what every call here accepts in
     *  place of an id, and what makes the address worth sending to somebody. */
    function containerHref(container: ContainerRow, tab: ContainerTab): string {
        const base = `/apps/containers/${encodeURIComponent(container.name)}?c=${encodeURIComponent(connectionId!)}`;
        return tab === "details" ? base : `${base}&tab=${tab}`;
    }

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
            <aside className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
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
                                    <span className="flex-1 truncate" title={connection.name}>
                                        {connection.name}
                                    </span>
                                    <Badge variant="neutral">
                                        {connection.local ? "local" : connection.transport}
                                    </Badge>
                                </Link>
                                {connection.local || connection.host ? null : (
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => onDeleteConnection(connection.id)}
                                        aria-label={`Remove ${connection.name}`}
                                        title={`Remove ${connection.name}`}
                                        className="md:opacity-0 md:group-hover:opacity-100"
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
                {localDiagnostic ? (
                    <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm">
                        <p className="font-medium">The local Docker host is not available yet</p>
                        <p className="mt-1 text-muted-foreground">{localDiagnostic.reason}</p>
                        <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <dt>Edition</dt>
                            <dd className="font-mono">{localDiagnostic.edition}</dd>
                            <dt>Host daemon</dt>
                            <dd className="font-mono">
                                {localDiagnostic.hostdPresent
                                    ? `present${localDiagnostic.hostdVersion ? ` (v${localDiagnostic.hostdVersion})` : ""}`
                                    : "not detected"}
                            </dd>
                            <dt>Docker socket</dt>
                            <dd className="font-mono">
                                {localDiagnostic.dockerReported ? "reported" : "not reported"}
                            </dd>
                        </dl>
                    </div>
                ) : null}
                {!connectionId ? (
                    <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        Connect a Docker host to monitor and manage containers.
                        <span className="mt-2 block">
                            The local host appears here automatically in the full edition. Use Add
                            host for a remote engine.
                        </span>
                    </div>
                ) : (
                    <>
                        {(actionError ?? error) ? (
                            <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                                {actionError ?? error}
                            </div>
                        ) : null}
                        {!actionError && !error && stale ? (
                            <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                                Showing the last reading. {stale}
                            </div>
                        ) : null}

                        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                            {snapshot ? (
                                <Overview
                                    overview={snapshot.overview}
                                    sampled={snapshot.statsAt !== null}
                                />
                            ) : (
                                [0, 1, 2, 3].map((tile) => (
                                    <Skeleton key={tile} className="h-[5.5rem] rounded-lg" />
                                ))
                            )}
                        </div>

                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">{statusLabel}</span>
                            <div className="flex items-center gap-2">
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setLive((value) => !value)}
                                >
                                    {live ? "Pause" : "Resume"}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={refresh}
                                    disabled={pending}
                                >
                                    <RefreshCw className="size-4" />
                                    Refresh
                                </Button>
                            </div>
                        </div>

                        <div className="overflow-x-auto rounded-lg border border-border">
                            <table className="w-full min-w-[44rem] text-sm">
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
                                    {!snapshot ? (
                                        [0, 1, 2, 3, 4].map((row) => (
                                            <tr key={row} className="border-t border-border">
                                                <td className="px-3 py-2" colSpan={5}>
                                                    <Skeleton className="h-9 w-full" />
                                                </td>
                                            </tr>
                                        ))
                                    ) : containers.length === 0 ? (
                                        <tr>
                                            <td
                                                colSpan={5}
                                                className="px-3 py-8 text-center text-muted-foreground"
                                            >
                                                No containers on this host.
                                            </td>
                                        </tr>
                                    ) : (
                                        containers.map((container) => (
                                            <tr
                                                key={container.id}
                                                className="border-t border-border hover:bg-card-hover"
                                            >
                                                <td className="px-3 py-2">
                                                    <Link
                                                        href={containerHref(container, "details")}
                                                        className="block max-w-full truncate text-left font-medium hover:underline"
                                                        title={container.name}
                                                    >
                                                        {container.name}
                                                    </Link>
                                                    <span
                                                        className="block truncate text-xs text-muted-foreground"
                                                        title={container.image}
                                                    >
                                                        {container.image}
                                                    </span>
                                                </td>
                                                <td className="px-3 py-2">
                                                    <Badge
                                                        variant={
                                                            container.state === "running"
                                                                ? "success"
                                                                : "neutral"
                                                        }
                                                    >
                                                        {container.state}
                                                    </Badge>
                                                </td>
                                                <UsageCell
                                                    running={container.state === "running"}
                                                    value={
                                                        container.cpuPercent === null
                                                            ? null
                                                            : `${container.cpuPercent}%`
                                                    }
                                                />
                                                <UsageCell
                                                    running={container.state === "running"}
                                                    value={
                                                        container.memUsage === null
                                                            ? null
                                                            : formatBytes(container.memUsage)
                                                    }
                                                />
                                                <td className="px-3 py-2">
                                                    <div className="flex justify-end gap-1">
                                                        <IconLink
                                                            label="Logs"
                                                            href={containerHref(container, "logs")}
                                                        >
                                                            <ScrollText className="size-4" />
                                                        </IconLink>
                                                        <IconLink
                                                            label="Files"
                                                            href={containerHref(container, "files")}
                                                        >
                                                            <FileText className="size-4" />
                                                        </IconLink>
                                                        {container.state === "running" ? (
                                                            <IconLink
                                                                label="Console"
                                                                href={containerHref(
                                                                    container,
                                                                    "console"
                                                                )}
                                                            >
                                                                <TerminalSquare className="size-4" />
                                                            </IconLink>
                                                        ) : (
                                                            <IconButton
                                                                label="Console"
                                                                onClick={() => undefined}
                                                                disabled
                                                            >
                                                                <TerminalSquare className="size-4" />
                                                            </IconButton>
                                                        )}
                                                        {canManage ? (
                                                            <>
                                                                {container.state === "running" ? (
                                                                    <>
                                                                        <IconButton
                                                                            label="Restart"
                                                                            onClick={() =>
                                                                                onAction(
                                                                                    container.id,
                                                                                    "restart"
                                                                                )
                                                                            }
                                                                            disabled={pending}
                                                                        >
                                                                            <RotateCw className="size-4" />
                                                                        </IconButton>
                                                                        <IconButton
                                                                            label="Stop"
                                                                            onClick={() =>
                                                                                onAction(
                                                                                    container.id,
                                                                                    "stop"
                                                                                )
                                                                            }
                                                                            disabled={pending}
                                                                        >
                                                                            <Square className="size-4" />
                                                                        </IconButton>
                                                                    </>
                                                                ) : (
                                                                    <IconButton
                                                                        label="Start"
                                                                        onClick={() =>
                                                                            onAction(
                                                                                container.id,
                                                                                "start"
                                                                            )
                                                                        }
                                                                        disabled={pending}
                                                                    >
                                                                        <Play className="size-4" />
                                                                    </IconButton>
                                                                )}
                                                                <IconButton
                                                                    label="Remove"
                                                                    onClick={() =>
                                                                        void onRemoveContainer(
                                                                            container
                                                                        )
                                                                    }
                                                                    disabled={pending}
                                                                >
                                                                    <Trash2 className="size-4" />
                                                                </IconButton>
                                                            </>
                                                        ) : null}
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
            {confirmDialog}
        </div>
    );
}

/** The host's headline figures. `sampled` is false until usage has been read at
 *  least once: the totals are zero until then, and a zero that means "not read
 *  yet" is worse than saying nothing. */
function Overview({ overview, sampled }: { overview: OverviewData; sampled: boolean }) {
    return (
        <>
            <Stat
                icon={<Boxes className="size-4" />}
                label="Containers"
                value={`${overview.running}/${overview.containers}`}
                hint="running / total"
            />
            <Stat
                icon={<Cpu className="size-4" />}
                label="CPU (containers)"
                value={sampled ? `${overview.aggregateCpuPercent}%` : null}
                hint={`${overview.ncpu} cores`}
            />
            <Stat
                icon={<MemoryStick className="size-4" />}
                label="Memory (containers)"
                value={sampled ? formatBytes(overview.aggregateMemUsage) : null}
                hint={`of ${formatBytes(overview.memTotal)}`}
            />
            <Stat
                icon={<Server className="size-4" />}
                label="Engine"
                value={overview.serverVersion || overview.name}
                hint={overview.name}
            />
        </>
    );
}

/** One headline number. A null value is one that has not arrived yet. */
function Stat({
    icon,
    label,
    value,
    hint
}: {
    icon: ReactNode;
    label: string;
    value: string | null;
    hint: string;
}) {
    return (
        <Card>
            <CardBody className="p-3">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    {icon}
                    {label}
                </div>
                {value === null ? (
                    <Skeleton className="h-6 w-20" />
                ) : (
                    <div className="truncate text-lg font-semibold" title={value}>
                        {value}
                    </div>
                )}
                <div className="truncate text-xs text-muted-foreground" title={hint}>
                    {hint}
                </div>
            </CardBody>
        </Card>
    );
}

/** A usage cell. A running container with no reading yet has one coming, which
 *  is a skeleton; a stopped one has nothing to read, which is a dash. */
function UsageCell({ running, value }: { running: boolean; value: string | null }) {
    return (
        <td className="px-3 py-2 text-muted-foreground">
            {value !== null ? value : running ? <Skeleton className="h-4 w-12" /> : "-"}
        </td>
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
        <Button
            size="icon"
            variant="ghost"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            title={label}
        >
            {children}
        </Button>
    );
}

/** The same control, for the ones that open a page. A link rather than a click
 *  handler so it can be middle-clicked, opened in a tab, or copied. */
function IconLink({ label, href, children }: { label: string; href: string; children: ReactNode }) {
    return (
        <Button size="icon" variant="ghost" asChild aria-label={label} title={label}>
            <Link href={href}>{children}</Link>
        </Button>
    );
}
