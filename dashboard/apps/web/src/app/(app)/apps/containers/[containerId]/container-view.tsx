"use client";

/**
 * One container's page: what it is costing, what it is storing, where it runs,
 * and the four ways of looking inside it (details, logs, files, a console).
 *
 * This used to be a dialog over the list, which meant a container had no address
 * of its own, no room for anything but a field list, and no way back to what you
 * were reading after a refresh. The page keeps the same four tabs and puts the
 * things a dialog had nowhere to put - live usage, disk, the host - above them.
 *
 * Four reads, deliberately not one: what the container is, what it occupies on
 * disk, the host it runs on, and a usage sample every five seconds. The disk
 * figure is its own read because the daemon walks the filesystem to answer it -
 * seconds, on a big image - and the rest of the page has no reason to wait
 * behind that. The host and the sample are seeded from what this tab last saw,
 * so a container opened from the listing paints its numbers at once and replaces
 * them as fresh ones land.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatBytes } from "@polaris/core";
import { formatAge, STALE_AFTER_MS } from "../freshness";
import { useConfirm } from "@/components/confirm-dialog";
import { useDisplayFormat } from "@/components/display-format";
import { useLiveResource } from "@/components/use-live-resource";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import { containerAction, removeContainerAction } from "../actions";
import { TerminalPanel } from "@/app/(app)/apps/deploy/terminal-panel";
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Skeleton,
    TimeSeriesChart,
    cn,
    type TimePoint
} from "@polaris/ui";
import type {
    ContainerDetailData,
    ContainerUsage,
    ContainerUsageReply,
    DockerConnectionSummary,
    HostInfo
} from "../types";
import {
    ArrowLeft,
    ChevronRight,
    Cpu,
    Download,
    FileText,
    Folder,
    HardDrive,
    MemoryStick,
    Network,
    Play,
    RefreshCw,
    RotateCw,
    ScrollText,
    Server,
    Square,
    TerminalSquare,
    Trash2
} from "lucide-react";

export type ContainerTab = "details" | "logs" | "files" | "console";

const TABS: Array<{ id: ContainerTab; label: string; icon: ReactNode }> = [
    { id: "details", label: "Details", icon: <FileText className="size-4" /> },
    { id: "logs", label: "Logs", icon: <ScrollText className="size-4" /> },
    { id: "files", label: "Files", icon: <Folder className="size-4" /> },
    { id: "console", label: "Console", icon: <TerminalSquare className="size-4" /> }
];

const REFRESH_MS = 5000;
/** How much history the charts hold: ten minutes at one sample every five
 *  seconds. It starts when the page opens - nothing is stored server-side, and a
 *  chart that claimed otherwise would be inventing the part you did not watch. */
const MAX_SAMPLES = 120;

/** A sample older than this is history rather than a reading: it is still worth
 *  showing with its age on it, but plotting it would draw a chart across a gap
 *  nobody watched. */
const CHARTABLE_AGE_MS = 60_000;

interface Sample {
    at: number;
    usage: ContainerUsage;
}

/** What the container occupies on disk. Read apart from the rest of the details
 *  because the daemon walks the filesystem to answer it. */
interface ContainerSizes {
    sizeRw: number | null;
    sizeRootFs: number | null;
}

export function ContainerView({
    connection,
    containerRef,
    initialTab,
    canManage
}: {
    connection: DockerConnectionSummary;
    /** The container's name (or id): what the URL carries and what every Docker
     *  call here accepts. */
    containerRef: string;
    /** Which tab the link that opened this page asked for. */
    initialTab: ContainerTab;
    canManage: boolean;
}) {
    const router = useRouter();
    const [confirm, confirmDialog] = useConfirm();
    const [pending, startTransition] = useTransition();
    const [tab, setTab] = useState<ContainerTab>(initialTab);
    const [samples, setSamples] = useState<Sample[]>([]);
    const [actionError, setActionError] = useState<string | null>(null);
    const [gone, setGone] = useState(false);

    const listHref = `/apps/containers?c=${encodeURIComponent(connection.id)}`;
    const query = `c=${encodeURIComponent(connection.id)}&id=${encodeURIComponent(containerRef)}`;
    const sizeKey = `container.size.${connection.id}.${containerRef}`;

    // What the container is. Without the size: the daemon walks the filesystem
    // for that one, and the header, the state and the details tab have no reason
    // to wait behind it.
    const {
        data: detail,
        error: detailError,
        stale: detailStale,
        refresh: reloadDetail
    } = useLiveResource<ContainerDetailData>({
        url: `/api/containers/inspect?${query}`,
        cacheKey: `container.detail.${connection.id}.${containerRef}`,
        intervalMs: 15_000,
        enabled: !gone,
        select: (body) => (body as { detail: ContainerDetailData }).detail
    });

    // The machine it runs on. It does not change while a page is open, so this
    // is slow-polled: what it is really for is painting from the last visit.
    const { data: host } = useLiveResource<HostInfo>({
        url: `/api/containers/host?c=${encodeURIComponent(connection.id)}`,
        cacheKey: `container.host.${connection.id}`,
        intervalMs: 60_000,
        select: (body) => body as HostInfo
    });

    // Usage, while the page is open. The server answers with its last sample and
    // takes a fresh one behind the reply, so a container opened from the listing
    // shows its numbers at once instead of a second of skeletons. A stopped
    // container answers with nothing to sample rather than an error, so the poll
    // keeps running: start it again and the chart carries on.
    const { data: usage } = useLiveResource<ContainerUsageReply>({
        url: `/api/containers/stats?${query}`,
        cacheKey: `container.usage.${connection.id}.${containerRef}`,
        intervalMs: REFRESH_MS,
        enabled: !gone,
        select: (body) => body as ContainerUsageReply
    });

    // What it occupies on disk, asked for once. This is the expensive inspect,
    // so it is neither polled nor in front of anything.
    const [sizes, setSizes] = useState<ContainerSizes | null>(
        () => readSnapshot<ContainerSizes>(sizeKey, 24 * 3_600_000)?.value ?? null
    );
    useEffect(() => {
        let cancelled = false;
        setSizes(readSnapshot<ContainerSizes>(sizeKey, 24 * 3_600_000)?.value ?? null);
        void (async () => {
            const result = await fetchJson<{ detail: ContainerDetailData }>(
                `/api/containers/inspect?${query}&size=1`
            );
            if (cancelled || !result.ok) return;
            const measured: ContainerSizes = {
                sizeRw: result.data.detail.sizeRw,
                sizeRootFs: result.data.detail.sizeRootFs
            };
            setSizes(measured);
            writeSnapshot(sizeKey, measured);
        })();
        return () => {
            cancelled = true;
        };
    }, [query, sizeKey]);

    // The chart holds what this page watched. A seeded sample from a previous
    // visit still has a number worth showing above, but plotting it would draw a
    // line across the minutes nobody was here for.
    useEffect(() => {
        const stats = usage?.stats ?? null;
        const at = usage?.at ?? null;
        if (!stats || at === null || Date.now() - at > CHARTABLE_AGE_MS) return;
        setSamples((previous) =>
            previous.at(-1)?.at === at
                ? previous
                : [...previous, { at, usage: stats }].slice(-MAX_SAMPLES)
        );
    }, [usage]);

    const state = detail?.state ?? "";
    const running = state === "running";
    const latest = usage?.stats ?? null;
    const latestAge = usage?.at ? Date.now() - usage.at : null;
    const error = actionError ?? detailError;

    function onLifecycle(action: "start" | "stop" | "restart"): void {
        setActionError(null);
        startTransition(async () => {
            const result = await containerAction(connection.id, containerRef, action);
            if (result.error) setActionError(result.error);
            reloadDetail();
        });
    }

    async function onRemove(): Promise<void> {
        const confirmed = await confirm({
            title: `Remove ${containerRef}?`,
            description: running
                ? "It is still running, so it will be stopped first. Named volumes and images are left alone."
                : "Named volumes and images are left alone.",
            confirmLabel: "Remove",
            danger: true
        });
        if (!confirmed) return;
        // The page is about a container that is about to stop existing: stop
        // polling it and go back to the list, which is where the answer to "did
        // it go" now lives. A refusal comes back here with the reason.
        setGone(true);
        startTransition(async () => {
            const result = await removeContainerAction(connection.id, containerRef, {
                force: running,
                volumes: false
            });
            if (result.error) {
                setGone(false);
                setActionError(result.error);
                return;
            }
            router.push(listHref);
            router.refresh();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                    <Link
                        href={listHref}
                        className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                        <ArrowLeft className="size-3" /> Containers
                    </Link>
                    <div className="flex flex-wrap items-center gap-2">
                        <h1
                            className="truncate text-[17px] font-semibold tracking-tight"
                            title={detail?.name || containerRef}
                        >
                            {detail?.name || containerRef}
                        </h1>
                        {detail ? (
                            <Badge variant={running ? "success" : "neutral"}>{state}</Badge>
                        ) : (
                            <Skeleton className="h-5 w-16 rounded-full" />
                        )}
                    </div>
                    <p
                        className="truncate text-xs text-muted-foreground"
                        title={detail?.image ?? undefined}
                    >
                        {detail?.image ?? ""}
                    </p>
                </div>
                <div className="flex items-center gap-1">
                    <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => reloadDetail()}
                        aria-label="Refresh"
                        title="Refresh"
                    >
                        <RefreshCw className="size-4" />
                    </Button>
                    {canManage ? (
                        <>
                            {running ? (
                                <>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => onLifecycle("restart")}
                                        disabled={pending}
                                        aria-label="Restart"
                                        title="Restart"
                                    >
                                        <RotateCw className="size-4" />
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => onLifecycle("stop")}
                                        disabled={pending}
                                        aria-label="Stop"
                                        title="Stop"
                                    >
                                        <Square className="size-4" />
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => onLifecycle("start")}
                                    disabled={pending || !detail}
                                    aria-label="Start"
                                    title="Start"
                                >
                                    <Play className="size-4" />
                                </Button>
                            )}
                            <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => void onRemove()}
                                disabled={pending || !detail}
                                aria-label="Remove"
                                title="Remove"
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </>
                    ) : null}
                </div>
            </div>

            {error ? (
                <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                    {error}
                </div>
            ) : detailStale ? (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                    Showing what was last read. {detailStale}
                </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat
                    icon={<Cpu className="size-4" />}
                    label="CPU"
                    value={latest ? `${latest.cpuPercent}%` : running ? null : "-"}
                    hint={host ? `${host.overview.ncpu} cores on the host` : "of the host's cores"}
                    age={latestAge}
                />
                <Stat
                    icon={<MemoryStick className="size-4" />}
                    label="Memory"
                    value={latest ? formatBytes(latest.memUsage) : running ? null : "-"}
                    hint={
                        latest && latest.memLimit > 0
                            ? `${latest.memPercent}% of ${formatBytes(latest.memLimit)}`
                            : "no limit set"
                    }
                    age={latestAge}
                />
                <Stat
                    icon={<Network className="size-4" />}
                    label="Network"
                    value={latest ? `${formatBytes(latest.netRx)} in` : running ? null : "-"}
                    hint={
                        latest
                            ? `${formatBytes(latest.netTx)} out, since it started`
                            : "since it started"
                    }
                    age={latestAge}
                />
                <Stat
                    icon={<HardDrive className="size-4" />}
                    label="Disk I/O"
                    value={latest ? `${formatBytes(latest.blockRead)} read` : running ? null : "-"}
                    hint={
                        latest
                            ? `${formatBytes(latest.blockWrite)} written, since it started`
                            : "since it started"
                    }
                    age={latestAge}
                />
            </div>

            {running ? <Usage samples={samples} /> : null}

            <div className="grid gap-4 lg:grid-cols-2">
                <RunsOn connection={connection} host={host} networks={detail?.networks ?? null} />
                <Storage detail={detail} sizes={sizes} />
            </div>

            <Card>
                <div
                    className="flex gap-1 overflow-x-auto border-b border-border px-2 py-2"
                    role="tablist"
                >
                    {TABS.map((entry) => (
                        <button
                            key={entry.id}
                            type="button"
                            role="tab"
                            aria-selected={tab === entry.id}
                            onClick={() => setTab(entry.id)}
                            className={cn(
                                "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-muted",
                                tab === entry.id ? "bg-muted font-medium" : "text-muted-foreground"
                            )}
                        >
                            {entry.icon}
                            {entry.label}
                        </button>
                    ))}
                </div>
                <CardBody className="min-h-[24rem]">
                    {tab === "details" ? <DetailsTab detail={detail} /> : null}
                    {tab === "logs" ? <LogsTab query={query} /> : null}
                    {tab === "files" ? <FilesTab query={query} /> : null}
                    {tab === "console" ? (
                        <ConsoleTab
                            connectionId={connection.id}
                            containerRef={containerRef}
                            name={detail?.name || containerRef}
                            running={running}
                            canAttach={host?.canAttach ?? false}
                        />
                    ) : null}
                </CardBody>
            </Card>
            {confirmDialog}
        </div>
    );
}

/** CPU and memory over the window the page has been open for. */
function Usage({ samples }: { samples: Sample[] }) {
    const format = useDisplayFormat();
    if (samples.length < 2) {
        return (
            <Card>
                <CardBody className="text-xs text-muted-foreground">
                    Watching usage. The chart fills in from here - the first points arrive within a
                    few seconds.
                </CardBody>
            </Card>
        );
    }

    const from = samples[0]?.at ?? Date.now();
    const to = samples.at(-1)?.at ?? from;
    const cpu: TimePoint[] = samples.map((sample) => ({
        t: sample.at,
        v: sample.usage.cpuPercent
    }));
    const memory: TimePoint[] = samples.map((sample) => ({
        t: sample.at,
        v: sample.usage.memUsage,
        note:
            sample.usage.memLimit > 0
                ? `${formatBytes(sample.usage.memUsage)} of ${formatBytes(sample.usage.memLimit)}`
                : formatBytes(sample.usage.memUsage)
    }));

    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <Card>
                <CardBody>
                    <TimeSeriesChart
                        points={cpu}
                        from={from}
                        to={to}
                        label="CPU"
                        format={(value) => `${Math.round(value * 100) / 100}%`}
                        formatTime={(at) => format.dateTime(at)}
                    />
                </CardBody>
            </Card>
            <Card>
                <CardBody>
                    <TimeSeriesChart
                        points={memory}
                        from={from}
                        to={to}
                        tone="success"
                        label="Memory"
                        format={(value) => formatBytes(value)}
                        formatTime={(at) => format.dateTime(at)}
                    />
                </CardBody>
            </Card>
        </div>
    );
}

/** The machine this container is on, and how Polaris reaches it. */
function RunsOn({
    connection,
    host,
    networks
}: {
    connection: DockerConnectionSummary;
    host: HostInfo | null;
    networks: string[] | null;
}) {
    const reach = connection.local
        ? "Local engine, brokered by the host daemon"
        : connection.host
          ? `Registered server, over ${connection.transport}`
          : `Docker connection, over ${connection.transport}`;

    return (
        <Card>
            <CardBody className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <Server className="size-4 text-muted-foreground" /> Runs on
                </div>
                <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
                    <Field label="Host">
                        <Link
                            href={`/apps/containers?c=${encodeURIComponent(connection.id)}`}
                            className="hover:underline"
                        >
                            {connection.name}
                        </Link>
                    </Field>
                    <Field label="Reached">{reach}</Field>
                    <Field label="Engine">
                        {host ? (
                            `${host.overview.name}${host.overview.serverVersion ? ` - ${host.overview.serverVersion}` : ""}`
                        ) : (
                            <Skeleton className="h-4 w-40" />
                        )}
                    </Field>
                    <Field label="Machine">
                        {host ? (
                            `${host.overview.ncpu} cores, ${formatBytes(host.overview.memTotal)}`
                        ) : (
                            <Skeleton className="h-4 w-32" />
                        )}
                    </Field>
                    <Field label="Networks">
                        {networks === null ? "" : networks.join(", ") || "-"}
                    </Field>
                </dl>
            </CardBody>
        </Card>
    );
}

/** What the container occupies, and what it has mounted. The two sizes arrive
 *  after the mounts do - the daemon walks the filesystem for them - so they
 *  carry their own skeleton rather than holding back the card. */
function Storage({
    detail,
    sizes
}: {
    detail: ContainerDetailData | null;
    sizes: ContainerSizes | null;
}) {
    return (
        <Card>
            <CardBody className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <HardDrive className="size-4 text-muted-foreground" /> Storage
                </div>
                {!detail ? (
                    <div className="space-y-2">
                        {[0, 1, 2].map((row) => (
                            <Skeleton key={row} className="h-4 w-full" />
                        ))}
                    </div>
                ) : (
                    <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
                        <Field label="Writable layer">
                            {!sizes ? (
                                <Skeleton className="h-4 w-24" />
                            ) : sizes.sizeRw === null ? (
                                "Not reported"
                            ) : (
                                formatBytes(sizes.sizeRw)
                            )}
                        </Field>
                        <Field label="Total on disk">
                            {!sizes ? (
                                <Skeleton className="h-4 w-32" />
                            ) : sizes.sizeRootFs === null ? (
                                "Not reported"
                            ) : (
                                `${formatBytes(sizes.sizeRootFs)} with its image layers`
                            )}
                        </Field>
                        <Field label="Mounts">
                            {detail.mounts.length === 0
                                ? "None"
                                : detail.mounts.map((mount) => (
                                      <div key={mount.destination} className="break-all text-xs">
                                          {mount.source} -&gt; {mount.destination} (
                                          {mount.rw ? "rw" : "ro"})
                                      </div>
                                  ))}
                        </Field>
                    </dl>
                )}
            </CardBody>
        </Card>
    );
}

function DetailsTab({ detail }: { detail: ContainerDetailData | null }) {
    const format = useDisplayFormat();

    if (!detail) {
        return (
            <div className="space-y-2">
                {[0, 1, 2, 3, 4, 5].map((row) => (
                    <Skeleton key={row} className="h-5 w-full" />
                ))}
            </div>
        );
    }

    return (
        <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
            <Field label="Container id">
                <code className="break-all text-xs">{detail.id.slice(0, 12)}</code>
            </Field>
            <Field label="Image">{detail.image}</Field>
            <Field label="Command">
                <code className="break-all text-xs">{detail.command || "-"}</code>
            </Field>
            <Field label="Created">{format.dateTime(detail.createdAt)}</Field>
            <Field label="Started">
                {detail.startedAt ? format.dateTime(detail.startedAt) : "-"}
            </Field>
            <Field label="Restarts">{detail.restartCount}</Field>
            {detail.composeProject ? (
                <Field label="Compose project">{detail.composeProject}</Field>
            ) : null}
            <Field label="Ports">
                {detail.ports.length === 0
                    ? "None published"
                    : detail.ports.map((port) => (
                          <div key={port.container}>
                              {port.host ? `${port.host} -> ` : ""}
                              {port.container}
                          </div>
                      ))}
            </Field>
            <Field label="Environment">
                {detail.env.length === 0 ? (
                    "None"
                ) : (
                    <>
                        <span className="text-xs text-muted-foreground">
                            Names only; values are never read.
                        </span>
                        <div className="mt-1 flex flex-wrap gap-1">
                            {detail.env.map((name) => (
                                <Badge key={name} variant="neutral">
                                    {name}
                                </Badge>
                            ))}
                        </div>
                    </>
                )}
            </Field>
        </dl>
    );
}

function LogsTab({ query }: { query: string }) {
    const [logs, setLogs] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tail, setTail] = useState(200);
    const [loading, setLoading] = useState(false);

    const load = useCallback(
        async (lines: number) => {
            setLoading(true);
            const result = await fetchJson<{ logs: string }>(
                `/api/containers/logs?${query}&tail=${lines}`
            );
            setLoading(false);
            if (!result.ok) setError(result.error);
            else {
                setError(null);
                setLogs(result.data.logs);
            }
        },
        [query]
    );

    useEffect(() => {
        void load(tail);
    }, [load, tail]);

    return (
        <div className="flex h-full flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">Last {tail} lines</span>
                <div className="flex items-center gap-1">
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setTail(tail >= 2000 ? 200 : tail * 5)}
                    >
                        {tail >= 2000 ? "Show fewer" : "Show more"}
                    </Button>
                    <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => void load(tail)}
                        disabled={loading}
                        aria-label="Refresh logs"
                        title="Refresh logs"
                    >
                        <RefreshCw className={cn("size-4", loading && "animate-spin")} />
                    </Button>
                </div>
            </div>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            {logs === null && !error ? (
                <Skeleton className="h-64 w-full" />
            ) : (
                <pre className="min-h-0 flex-1 overflow-auto rounded-md bg-[#0b0e14] p-3 text-xs leading-relaxed text-[#c9d1d9]">
                    {logs?.trim() ? logs : "This container has printed nothing."}
                </pre>
            )}
        </div>
    );
}

function FilesTab({ query }: { query: string }) {
    const [path, setPath] = useState("/");
    const [entries, setEntries] = useState<Array<{ name: string; isDir: boolean }> | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setEntries(null);
        void (async () => {
            const result = await fetchJson<{ entries: Array<{ name: string; isDir: boolean }> }>(
                `/api/containers/files?${query}&p=${encodeURIComponent(path)}`
            );
            if (cancelled) return;
            if (!result.ok) {
                setError(result.error);
                setEntries([]);
            } else {
                setError(null);
                setEntries(result.data.entries);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [query, path]);

    const segments = path.split("/").filter(Boolean);

    return (
        <div className="flex h-full flex-col gap-2">
            <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Breadcrumb">
                <button type="button" className="hover:underline" onClick={() => setPath("/")}>
                    /
                </button>
                {segments.map((segment, index) => (
                    <span key={`${segment}-${index}`} className="flex items-center gap-1">
                        <ChevronRight className="size-3 text-muted-foreground" />
                        <button
                            type="button"
                            className="hover:underline"
                            onClick={() => setPath(`/${segments.slice(0, index + 1).join("/")}`)}
                        >
                            {segment}
                        </button>
                    </span>
                ))}
            </nav>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            {entries === null ? (
                <div className="space-y-1">
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
                        <Skeleton key={row} className="h-8 w-full" />
                    ))}
                </div>
            ) : entries.length === 0 && !error ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                    This directory is empty.
                </p>
            ) : (
                <ul className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
                    {entries.map((entry) => {
                        const full = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
                        return (
                            <li
                                key={entry.name}
                                className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm last:border-b-0 hover:bg-card-hover"
                            >
                                {entry.isDir ? (
                                    <>
                                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                                        <button
                                            type="button"
                                            className="flex-1 truncate text-left hover:underline"
                                            onClick={() => setPath(full)}
                                            title={entry.name}
                                        >
                                            {entry.name}
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                                        <span className="flex-1 truncate" title={entry.name}>
                                            {entry.name}
                                        </span>
                                        <a
                                            href={`/api/containers/file?${query}&p=${encodeURIComponent(full)}`}
                                            aria-label={`Download ${entry.name}`}
                                            title={`Download ${entry.name}`}
                                            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                        >
                                            <Download className="size-4" />
                                        </a>
                                    </>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

function ConsoleTab({
    connectionId,
    containerRef,
    name,
    running,
    canAttach
}: {
    connectionId: string;
    containerRef: string;
    name: string;
    running: boolean;
    canAttach: boolean;
}) {
    if (!running) {
        return (
            <Notice tone="muted">
                <TerminalSquare className="mb-2 size-5" />
                Start this container to open a console in it.
            </Notice>
        );
    }
    if (!canAttach) {
        return (
            <Notice tone="muted">
                This host does not offer an interactive session. Its engine is reached through the
                host daemon, which brokers one bounded call at a time.
            </Notice>
        );
    }
    return (
        <TerminalPanel
            target={{ kind: "docker", connectionId, containerRef }}
            label={`${name} - /bin/sh`}
        />
    );
}

/**
 * One headline number. A null value is one that has not arrived yet.
 *
 * `age` is how old the reading is. Under a few seconds it is what "live" means
 * and goes unsaid; past that the tile says when it was taken, because a number
 * from two minutes ago presented as this instant's is the one way a usage panel
 * can actually mislead.
 */
function Stat({
    icon,
    label,
    value,
    hint,
    age
}: {
    icon: ReactNode;
    label: string;
    value: string | null;
    hint: string;
    age?: number | null;
}) {
    const stale = value !== null && age !== null && age !== undefined && age > STALE_AFTER_MS;
    const caption = stale ? `${hint} - ${formatAge(age)} ago` : hint;
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
                <div className="truncate text-xs text-muted-foreground" title={caption}>
                    {caption}
                </div>
            </CardBody>
        </Card>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </>
    );
}

function Notice({ tone, children }: { tone: "danger" | "muted"; children: ReactNode }) {
    return (
        <div
            className={cn(
                "rounded-md border p-3 text-sm",
                tone === "danger"
                    ? "border-danger/40 bg-danger/10 text-danger"
                    : "border-border bg-card text-muted-foreground"
            )}
        >
            {children}
        </div>
    );
}

/** Fetch JSON and normalize both a transport failure and an `{ error }` body
 *  into one shape, so every caller handles failure the same way. */
async function fetchJson<T>(
    url: string
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    try {
        const response = await fetch(url);
        const payload = (await response.json()) as T & { error?: string };
        if (!response.ok || payload.error) {
            return { ok: false, error: payload.error ?? `Request failed (${response.status})` };
        }
        return { ok: true, data: payload };
    } catch {
        return { ok: false, error: "Could not reach Polaris" };
    }
}
