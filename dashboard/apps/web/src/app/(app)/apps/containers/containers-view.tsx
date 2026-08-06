"use client";

/**
 * Containers view: a host overview (CPU/memory/counts) and a live table of
 * containers with lifecycle controls, logs, files, a console and removal.
 *
 * The data is fetched from /api/containers rather than server-rendered, so the
 * host list and the table chrome are on screen before a possibly-remote engine
 * has answered. The same fetch backs the 5s refresh, so first load and live
 * updates run one code path. Actions call the server actions, which re-check
 * permission before touching Docker.
 */

import Link from "next/link";
import { formatBytes } from "@polaris/core";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/confirm-dialog";
import { DockerConnectionDialog } from "./docker-connection-dialog";
import { Badge, Button, Card, CardBody, Skeleton, cn } from "@polaris/ui";
import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { containerAction, deleteDockerConnectionAction, removeContainerAction } from "./actions";
import type { ContainerRow, DockerConnectionSummary, HostSnapshot, LocalHostDiagnostic, OverviewData } from "./types";
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
    const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(connectionId !== null);
    // Containers whose removal is in flight. They are already off the table - the
    // engine takes a moment to stop one, and a row that sits there until the next
    // refresh reads as a button that did nothing. A refusal puts the row back.
    const [removing, setRemoving] = useState<string[]>([]);
    // A refresh must never overwrite fresher data with a reply that raced it.
    const requestRef = useRef(0);

    const load = useCallback(
        async (id: string, showSkeleton: boolean) => {
            const request = ++requestRef.current;
            if (showSkeleton) setLoading(true);
            try {
                const response = await fetch(`/api/containers?c=${encodeURIComponent(id)}`);
                const payload = (await response.json()) as HostSnapshot & { error?: string };
                if (request !== requestRef.current) return;
                if (!response.ok || payload.error) {
                    setError(payload.error ?? `Could not reach this host (${response.status})`);
                    setSnapshot(null);
                } else {
                    setError(null);
                    setSnapshot(payload);
                    // A container the engine no longer lists is gone for real, so
                    // it no longer needs hiding; one still listed is still on its
                    // way out and stays hidden.
                    setRemoving((ids) =>
                        ids.filter((id) => payload.containers.some((row) => row.id === id))
                    );
                }
            } catch {
                if (request === requestRef.current) {
                    setError("Could not reach Polaris");
                    setSnapshot(null);
                }
            } finally {
                if (request === requestRef.current) setLoading(false);
            }
        },
        []
    );

    // First load for the selected host, and a fresh one whenever it changes.
    useEffect(() => {
        if (!connectionId) {
            setSnapshot(null);
            setLoading(false);
            return;
        }
        setSnapshot(null);
        void load(connectionId, true);
    }, [connectionId, load]);

    // Poll for fresh stats. A silent refresh, so the table never flashes back to
    // a skeleton once it has data.
    useEffect(() => {
        if (!live || !connectionId) return;
        const timer = setInterval(() => void load(connectionId, false), REFRESH_MS);
        return () => clearInterval(timer);
    }, [live, connectionId, load]);

    const refresh = useCallback(() => {
        if (connectionId) void load(connectionId, false);
    }, [connectionId, load]);

    function onAction(containerId: string, action: "start" | "stop" | "restart") {
        startTransition(async () => {
            const result = await containerAction(connectionId!, containerId, action);
            if (result.error) setError(result.error);
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
                setError(result.error);
            }
            refresh();
        });
    }

    async function onDeleteConnection(id: string) {
        if (!(await confirm({ title: "Remove this Docker connection?", confirmLabel: "Remove", danger: true }))) return;
        startTransition(async () => {
            await deleteDockerConnectionAction(id);
            router.refresh();
        });
    }

    const containers = (snapshot?.containers ?? []).filter((container) => !removing.includes(container.id));

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
                                    <span className="flex-1 truncate">{connection.name}</span>
                                    <Badge variant="neutral">{connection.local ? "local" : connection.transport}</Badge>
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
                            <dd className="font-mono">{localDiagnostic.dockerReported ? "reported" : "not reported"}</dd>
                        </dl>
                    </div>
                ) : null}
                {!connectionId ? (
                    <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        Connect a Docker host to monitor and manage containers.
                        <span className="mt-2 block">
                            The local host appears here automatically in the full edition. Use Add host for a
                            remote engine.
                        </span>
                    </div>
                ) : (
                    <>
                        {error ? (
                            <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                                {error}
                            </div>
                        ) : null}

                        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                            {snapshot ? (
                                <Overview overview={snapshot.overview} />
                            ) : (
                                [0, 1, 2, 3].map((tile) => <Skeleton key={tile} className="h-[5.5rem] rounded-lg" />)
                            )}
                        </div>

                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">
                                {loading && !snapshot ? "Loading" : live ? "Live - refreshing every 5s" : "Paused"}
                            </span>
                            <div className="flex items-center gap-2">
                                <Button size="sm" variant="ghost" onClick={() => setLive((value) => !value)}>
                                    {live ? "Pause" : "Resume"}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={refresh} disabled={pending}>
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
                                            <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                                                No containers on this host.
                                            </td>
                                        </tr>
                                    ) : (
                                        containers.map((container) => (
                                            <tr key={container.id} className="border-t border-border hover:bg-card-hover">
                                                <td className="px-3 py-2">
                                                    <Link
                                                        href={containerHref(container, "details")}
                                                        className="block max-w-full truncate text-left font-medium hover:underline"
                                                    >
                                                        {container.name}
                                                    </Link>
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
                                                        <IconLink label="Logs" href={containerHref(container, "logs")}>
                                                            <ScrollText className="size-4" />
                                                        </IconLink>
                                                        <IconLink label="Files" href={containerHref(container, "files")}>
                                                            <FileText className="size-4" />
                                                        </IconLink>
                                                        {container.state === "running" ? (
                                                            <IconLink
                                                                label="Console"
                                                                href={containerHref(container, "console")}
                                                            >
                                                                <TerminalSquare className="size-4" />
                                                            </IconLink>
                                                        ) : (
                                                            <IconButton label="Console" onClick={() => undefined} disabled>
                                                                <TerminalSquare className="size-4" />
                                                            </IconButton>
                                                        )}
                                                        {canManage ? (
                                                            <>
                                                                {container.state === "running" ? (
                                                                    <>
                                                                        <IconButton
                                                                            label="Restart"
                                                                            onClick={() => onAction(container.id, "restart")}
                                                                            disabled={pending}
                                                                        >
                                                                            <RotateCw className="size-4" />
                                                                        </IconButton>
                                                                        <IconButton
                                                                            label="Stop"
                                                                            onClick={() => onAction(container.id, "stop")}
                                                                            disabled={pending}
                                                                        >
                                                                            <Square className="size-4" />
                                                                        </IconButton>
                                                                    </>
                                                                ) : (
                                                                    <IconButton
                                                                        label="Start"
                                                                        onClick={() => onAction(container.id, "start")}
                                                                        disabled={pending}
                                                                    >
                                                                        <Play className="size-4" />
                                                                    </IconButton>
                                                                )}
                                                                <IconButton
                                                                    label="Remove"
                                                                    onClick={() => void onRemoveContainer(container)}
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

function Overview({ overview }: { overview: OverviewData }) {
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
                value={`${overview.aggregateCpuPercent}%`}
                hint={`${overview.ncpu} cores`}
            />
            <Stat
                icon={<MemoryStick className="size-4" />}
                label="Memory (containers)"
                value={formatBytes(overview.aggregateMemUsage)}
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

/** The same control, for the ones that open a page. A link rather than a click
 *  handler so it can be middle-clicked, opened in a tab, or copied. */
function IconLink({ label, href, children }: { label: string; href: string; children: ReactNode }) {
    return (
        <Button size="icon" variant="ghost" asChild aria-label={label} title={label}>
            <Link href={href}>{children}</Link>
        </Button>
    );
}
