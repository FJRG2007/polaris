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
import { carryForwardUsage } from "./usage";
import { formatAge, STALE_AFTER_MS } from "./freshness";
import { useConfirm } from "@/components/confirm-dialog";
import { PolarisFootprintCard } from "./polaris-footprint";
import { containerStateLabel } from "./container-words";
import { containerMachineId, machineHref } from "@/lib/machines/machine-links";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useLiveResource } from "@/components/use-live-resource";
import { useDebounced } from "@/app/(app)/telemetry/use-debounced";
import { RowActionsMenu, RowContextMenu, type RowAction } from "@/components/row-menu";
import {
    DEFAULT_DIRECTION,
    type ConsumptionOrder,
    type SortDirection
} from "@/lib/watch/card-order";
import {
    DEFAULT_LIST_QUERY,
    PAGE_SIZE,
    STATE_FILTERS,
    listSearchParams,
    stateGroup,
    type ContainerListQuery,
    type OwnerFilter,
    type StateFilter
} from "./container-list";
import { DockerConnectionDialog } from "./docker-connection-dialog";
import {
    Badge,
    Button,
    Card,
    CardBody,
    SegmentedControl,
    Select,
    Skeleton,
    cn,
    SearchField,
    SortHeader,
    useToast
} from "@polaris/ui";
import { PagedPicker } from "@/components/paged-picker";
import {
    connectionOptionsAction,
    containerAction,
    deleteDockerConnectionAction,
    removeContainerAction
} from "./actions";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    useTransition,
    type ReactNode
} from "react";
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
    House,
    Info,
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

/** How often the registered servers are re-checked. One short socket each. */
const HOST_STATUS_POLL_MS = 30_000;

/** One server's reachability, as /api/containers/host-status reports it. */
interface HostReachability {
    id: string;
    state: "up" | "down";
    detail: string | null;
}

/** Which tab of a container's page a row's action opens. */
type ContainerTab = "details" | "logs" | "files" | "console";

/** How long the search box waits for typing to stop before asking the server. */
const SEARCH_SETTLE_MS = 250;

/** A lifecycle action as the row shows it before the engine has confirmed it. */
const OPTIMISTIC_STATE: Record<"start" | "stop" | "restart", string> = {
    start: "running",
    stop: "exited",
    restart: "restarting"
};

/** How long a state shown ahead of the engine is held without a listing that
 *  agrees with it, before the row goes back to saying what the engine says. */
const OPTIMISTIC_HOLD_MS = 20_000;

export function ContainersView({
    connections,
    connectionId,
    sshEnabled,
    canManage,
    localDiagnostic,
    more = false
}: {
    /** The first page of hosts, and the selected one when it is past it. */
    connections: DockerConnectionSummary[];
    /** Whether there are hosts past that page, found through the picker. */
    more?: boolean;
    connectionId: string | null;
    sshEnabled: boolean;
    canManage: boolean;
    localDiagnostic: LocalHostDiagnostic | null;
}) {
    const t = useTranslations("containers");
    const router = useRouter();
    // Whether the host on screen is the machine Polaris runs on, which is the only
    // one that has a Polaris to measure.
    const isLocalHost = connections.some(
        (connection) => connection.id === connectionId && connection.local
    );
    const [, startTransition] = useTransition();
    const toast = useToast();
    const [live, setLive] = useState(true);
    const [confirm, confirmDialog] = useConfirm();
    // Containers whose removal is in flight. They are already off the table - the
    // engine takes a moment to stop one, and a row that sits there until the next
    // refresh reads as a button that did nothing. A refusal puts the row back.
    const [removing, setRemoving] = useState<string[]>([]);
    // Why an action failed, which is a different thing from the host having
    // stopped answering and must not be wiped by the next successful poll.
    const [actionError, setActionError] = useState<string | null>(null);
    // What the table is ordered by. By name to begin with rather than by load: the
    // figures move every five seconds, and a table that reorders itself under a
    // pointer is only wanted by somebody who asked for it.
    const [sort, setSort] = useState<{ order: ConsumptionOrder; direction: SortDirection }>({
        order: "name",
        direction: DEFAULT_LIST_QUERY.direction
    });
    // Which containers: typed into the search box, whose they are, what state.
    // Applied by the server, which sends only the rows asked for.
    const [search, setSearch] = useState("");
    const settledSearch = useDebounced(search, SEARCH_SETTLE_MS);
    const [owner, setOwner] = useState<OwnerFilter>(DEFAULT_LIST_QUERY.owner);
    const [stateFilter, setStateFilter] = useState<StateFilter>(DEFAULT_LIST_QUERY.state);
    const [limit, setLimit] = useState(PAGE_SIZE);
    // Containers with a lifecycle action in flight, and the state each is shown
    // in until the engine's own listing agrees - or the action fails, which puts
    // the row back the way it was.
    const [busy, setBusy] = useState<string[]>([]);
    const [optimistic, setOptimistic] = useState<
        Record<string, { state: string; settled: boolean; at: number }>
    >({});

    // Whether the registered servers in the list are answering. Only polled when
    // there is one: the local engine and a stored connection are not probed.
    const { data: reachability } = useLiveResource<HostReachability[]>({
        url: "/api/containers/host-status",
        cacheKey: "containers.host-status",
        intervalMs: HOST_STATUS_POLL_MS,
        enabled: connections.some((connection) => connection.hostId),
        select: (body) => (body as { servers: HostReachability[] }).servers
    });
    /** Why a server in the list is not answering, or null while it answers - and
     *  while the answer is still on its way, which is not the same as down. */
    const downReason = useCallback(
        (connection: DockerConnectionSummary): string | null => {
            if (!connection.hostId || !reachability) return null;
            const status = reachability.find((entry) => entry.id === connection.hostId);
            return status?.state === "down" ? (status.detail ?? t("hosts.noAnswer")) : null;
        },
        [reachability, t]
    );
    const selected = connections.find((connection) => connection.id === connectionId) ?? null;
    const unreachable = selected ? downReason(selected) : null;

    // Seeded from the last answer this tab held for the host, polled while the
    // tab is in front, and folded in so only the numbers that moved re-render.
    // Only a host with Polaris on it has Polaris containers to tell apart.
    const listQuery: ContainerListQuery = {
        q: settledSearch,
        owner: isLocalHost ? owner : "all",
        state: stateFilter,
        order: sort.order,
        direction: sort.direction,
        limit
    };
    const listParams = connectionId ? listSearchParams(connectionId, listQuery).toString() : "";
    const {
        data: answer,
        loading,
        error,
        stale,
        refresh: reload
    } = useLiveResource<HostSnapshot>({
        url: connectionId ? `/api/containers?${listParams}` : "",
        // One kept answer per host and query, so a revisit paints exactly what it
        // asked for. Not the bare `containers.<id>` key: a server's page reads
        // that one expecting every container on the host.
        cacheKey: `containers.list.${listParams || "none"}`,
        intervalMs: REFRESH_MS,
        // Not asked of a server that is off: it would only spend its SSH connect
        // timeout to fail, every five seconds.
        enabled: connectionId !== null && unreachable === null,
        // Pausing stops the refresh, not the load: picking a different host while
        // paused still has to put that host on screen.
        paused: !live,
        select: (body) => body as HostSnapshot
    });

    // What the table is actually showing, which is not always what the last answer
    // carried: a host the server has no sample for answers with the containers and
    // no figures, and blanking numbers that were on screen a second ago is worse
    // than showing them with their age. Held per host, so switching hosts does not
    // fill one machine's table with another's readings.
    const shown = useRef<{ connectionId: string | null; snapshot: HostSnapshot } | null>(null);
    // A filter that has just changed has no answer of its own yet; the table goes
    // on showing what it had for this host until it lands, rather than blanking
    // to a skeleton on every keystroke.
    const snapshot = useMemo(() => {
        const previous =
            shown.current?.connectionId === connectionId ? shown.current.snapshot : null;
        if (!answer) return previous;
        const merged = carryForwardUsage(previous, answer);
        shown.current = { connectionId, snapshot: merged };
        return merged;
    }, [answer, connectionId]);
    const filtering = !answer && snapshot !== null;

    // A container the engine no longer lists is gone for real, so it no longer
    // needs hiding; one still listed is still on its way out and stays hidden.
    useEffect(() => {
        if (!answer) return;
        setRemoving((ids) => ids.filter((id) => answer.containers.some((row) => row.id === id)));
        // A state shown ahead of the engine is dropped once the engine says the
        // same, once the container has left the listing, or once it has been held
        // long enough that the engine evidently did something else.
        setOptimistic((held) => {
            let changed = false;
            const next: typeof held = {};
            for (const [id, entry] of Object.entries(held)) {
                const row = answer.containers.find((container) => container.id === id);
                const agreed = !row || stateGroup(row.state) === stateGroup(entry.state);
                const expired = Date.now() - entry.at > OPTIMISTIC_HOLD_MS;
                if (entry.settled && (agreed || expired)) changed = true;
                else next[id] = entry;
            }
            return changed ? next : held;
        });
    }, [answer]);

    const refresh = useCallback(() => {
        if (connectionId) reload();
    }, [connectionId, reload]);

    function onAction(containerId: string, action: "start" | "stop" | "restart") {
        setActionError(null);
        setBusy((ids) => [...ids, containerId]);
        setOptimistic((held) => ({
            ...held,
            [containerId]: { state: OPTIMISTIC_STATE[action], settled: false, at: Date.now() }
        }));
        const rollback = () =>
            setOptimistic((held) => {
                const { [containerId]: _dropped, ...rest } = held;
                return rest;
            });
        startTransition(async () => {
            try {
                const result = await containerAction(connectionId!, containerId, action);
                if (result.error) setActionError(result.error);
                if (result.queued) toast.show({ title: t("queued.title"), body: t("queued.body") });
                // Refused, or waiting for a server that is not answering: nothing
                // has happened to the container yet, so the row says so again.
                if (result.error || result.queued) rollback();
                else
                    setOptimistic((held) =>
                        held[containerId]
                            ? { ...held, [containerId]: { ...held[containerId], settled: true } }
                            : held
                    );
            } catch {
                rollback();
                setActionError(t("errors.actionFailed"));
            } finally {
                setBusy((ids) => ids.filter((id) => id !== containerId));
                refresh();
            }
        });
    }

    async function onRemoveContainer(container: ContainerRow) {
        const running = container.state === "running";
        const confirmed = await confirm({
            title: t("remove.title", { name: container.name }),
            description: running ? t("remove.running") : t("remove.stopped"),
            confirmLabel: t("remove.confirm"),
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
                title: t("remove.connectionTitle"),
                confirmLabel: t("remove.confirm"),
                danger: true
            }))
        )
            return;
        startTransition(async () => {
            await deleteDockerConnectionAction(id);
            router.refresh();
        });
    }

    // Already filtered and ordered by the server; only what this tab knows ahead
    // of it is applied here - a removal on its way, a state change not yet seen.
    const containers = useMemo(
        () =>
            (snapshot?.containers ?? [])
                .filter((container) => !removing.includes(container.id))
                .map((container) => {
                    const held = optimistic[container.id];
                    return held ? { ...container, state: held.state } : container;
                }),
        [snapshot, removing, optimistic]
    );
    const matched = Math.max(
        containers.length,
        (snapshot?.matched ?? snapshot?.containers.length ?? 0) -
            (snapshot?.containers.length ?? 0) +
            containers.length
    );
    const filtered = search.trim() !== "" || owner !== "all" || stateFilter !== "all";

    /** Sort by this column, or turn it round when it is the one already sorted. */
    function sortBy(order: ConsumptionOrder): void {
        setSort((held) =>
            held.order === order
                ? { order, direction: held.direction === "asc" ? "desc" : "asc" }
                : { order, direction: DEFAULT_DIRECTION[order] }
        );
    }

    /** A narrower question starts from the first page again. */
    function narrow(apply: () => void): void {
        apply();
        setLimit(PAGE_SIZE);
    }

    function clearFilters(): void {
        narrow(() => {
            setSearch("");
            setOwner("all");
            setStateFilter("all");
        });
    }

    /** Everything a row offers, for its three dots and its right-click alike. Only
     *  what the caller may do: managing a container is the same `system.manage`
     *  the actions check, and is left off the menu rather than refused. */
    function rowActions(container: ContainerRow): RowAction[] {
        const running = container.state === "running";
        const rowBusy = busy.includes(container.id);
        const places = placesId(container);
        const actions: RowAction[] = [
            {
                key: "open",
                label: t("actions.open"),
                icon: <Info />,
                href: containerHref(container, "details")
            }
        ];
        if (places) {
            actions.push({
                key: "places",
                label: t("actions.places"),
                icon: <House />,
                href: machineHref("container", places)
            });
        }
        actions.push(
            {
                key: "logs",
                label: t("actions.logs"),
                icon: <ScrollText />,
                href: containerHref(container, "logs")
            },
            {
                key: "files",
                label: t("actions.files"),
                icon: <FileText />,
                href: containerHref(container, "files")
            },
            {
                key: "console",
                label: t("actions.console"),
                icon: <TerminalSquare />,
                href: containerHref(container, "console"),
                disabled: !running
            }
        );
        if (!canManage) return actions;
        if (running) {
            actions.push(
                {
                    key: "restart",
                    label: t("actions.restart"),
                    icon: <RotateCw />,
                    onSelect: () => onAction(container.id, "restart"),
                    disabled: rowBusy,
                    manage: true
                },
                {
                    key: "stop",
                    label: t("actions.stop"),
                    icon: <Square />,
                    onSelect: () => onAction(container.id, "stop"),
                    disabled: rowBusy,
                    manage: true
                }
            );
        } else {
            actions.push({
                key: "start",
                label: t("actions.start"),
                icon: <Play />,
                onSelect: () => onAction(container.id, "start"),
                disabled: rowBusy || container.state === "restarting",
                manage: true
            });
        }
        actions.push({
            key: "remove",
            label: t("remove.confirm"),
            icon: <Trash2 />,
            onSelect: () => void onRemoveContainer(container),
            disabled: rowBusy,
            danger: true,
            manage: true
        });
        return actions;
    }
    // Usage is sampled behind the request, so the listing can be answered without
    // waiting for it. Say when what is shown was taken rather than let a reading
    // that has aged pass for this instant's.
    const usageAge = snapshot?.statsAt ? Date.now() - snapshot.statsAt : null;
    const statusLabel = !live
        ? t("live.paused")
        : loading || filtering
          ? t("live.loading")
          : usageAge === null
            ? t("live.firstReading")
            : usageAge > STALE_AFTER_MS
              ? t("live.aged", { age: formatAge(usageAge) })
              : t("live.refreshing");

    /** A container's own page, on the host it was listed from. Named rather than
     *  identified: it is what Docker calls it, what every call here accepts in
     *  place of an id, and what makes the address worth sending to somebody. */
    function placesId(container: ContainerRow): string | null {
        return selected ? containerMachineId(selected, container.id) : null;
    }

    function containerHref(container: ContainerRow, tab: ContainerTab): string {
        const base = `/apps/containers/${encodeURIComponent(container.name)}?c=${encodeURIComponent(connectionId!)}`;
        return tab === "details" ? base : `${base}&tab=${tab}`;
    }

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
            <aside className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-medium text-muted-foreground">
                        {t("hosts.title")}
                    </h2>
                    <DockerConnectionDialog sshEnabled={sshEnabled} />
                </div>
                {more ? (
                    <PagedPicker<DockerConnectionSummary>
                        read={connectionOptionsAction}
                        scope={{}}
                        cache="container-hosts"
                        value={null}
                        onValueChange={(id) =>
                            router.push(`/apps/containers?c=${encodeURIComponent(id)}`)
                        }
                        placeholder={t("hosts.find")}
                        searchPlaceholder={t("hosts.search")}
                        emptyText={t("hosts.noMatch")}
                        aria-label={t("hosts.find")}
                    />
                ) : null}
                <nav className="flex flex-col gap-1">
                    {connections.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("hosts.none")}</p>
                    ) : (
                        connections.map((connection) => (
                            <div key={connection.id} className="group flex items-center gap-1">
                                {downReason(connection) ? (
                                    // Off, so there is nothing to open: listing it
                                    // would only spend its connect timeout to say so.
                                    <span
                                        aria-disabled="true"
                                        title={t("hosts.notAnswering", {
                                            reason: downReason(connection) ?? ""
                                        })}
                                        className={cn(
                                            "flex flex-1 cursor-not-allowed items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground",
                                            connection.id === connectionId && "bg-muted font-medium"
                                        )}
                                    >
                                        <Server className="size-4" />
                                        <span className="flex-1 truncate">{connection.name}</span>
                                        <Badge variant="danger">{t("hosts.offline")}</Badge>
                                    </span>
                                ) : (
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
                                            {connection.local
                                                ? t("hosts.local")
                                                : connection.transport}
                                        </Badge>
                                    </Link>
                                )}
                                {connection.local || connection.host ? null : (
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => onDeleteConnection(connection.id)}
                                        aria-label={t("hosts.removeNamed", {
                                            name: connection.name
                                        })}
                                        title={t("hosts.removeNamed", { name: connection.name })}
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
                    <div className="mb-4 rounded-md border border-warning-edge bg-warning-soft p-4 text-sm">
                        <p className="font-medium">{t("local.title")}</p>
                        <p className="mt-1 text-muted-foreground">{localDiagnostic.reason}</p>
                        <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <dt>{t("local.edition")}</dt>
                            <dd className="font-mono">{localDiagnostic.edition}</dd>
                            <dt>{t("local.hostd")}</dt>
                            <dd className="font-mono">
                                {localDiagnostic.hostdPresent
                                    ? localDiagnostic.hostdVersion
                                        ? t("local.presentVersion", {
                                              version: localDiagnostic.hostdVersion
                                          })
                                        : t("local.present")
                                    : t("local.notDetected")}
                            </dd>
                            <dt>{t("local.socket")}</dt>
                            <dd className="font-mono">
                                {localDiagnostic.dockerReported
                                    ? t("local.reported")
                                    : t("local.notReported")}
                            </dd>
                        </dl>
                    </div>
                ) : null}
                {!connectionId ? (
                    <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        {t("empty.connect")}
                        <span className="mt-2 block">{t("empty.local")}</span>
                    </div>
                ) : unreachable && selected ? (
                    <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                        <p className="font-medium text-foreground">
                            {t("down.title", { name: selected.name })}
                        </p>
                        <p className="mt-1">{unreachable}</p>
                        <p className="mt-3">
                            {t.rich("down.body", {
                                link: (chunks) => (
                                    <Link
                                        key="link"
                                        href={`/apps/servers/${selected.hostId}`}
                                        className="underline hover:text-foreground"
                                    >
                                        {chunks}
                                    </Link>
                                )
                            })}
                        </p>
                    </div>
                ) : (
                    <>
                        {(actionError ?? error) ? (
                            <div className="mb-4 rounded-md border border-danger-edge bg-danger-soft p-3 text-sm text-danger-ink">
                                {actionError ?? error}
                            </div>
                        ) : null}
                        {!actionError && !error && stale ? (
                            <div className="mb-4 rounded-md border border-warning-edge bg-warning-soft p-3 text-sm">
                                {t("live.stale", { reason: stale })}
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

                        {/* Only where Polaris is installed. Its own containers are
                            in the table below, mixed in with everything deployed,
                            which says whether they are running and nothing about
                            what they cost. */}
                        {isLocalHost && <PolarisFootprintCard />}

                        <div className="mb-2 flex flex-wrap items-center gap-2">
                            <SearchField
                                wrapperClassName="flex-1 basis-48"
                                value={search}
                                onChange={(event) => narrow(() => setSearch(event.target.value))}
                                placeholder={t("list.search")}
                                aria-label={t("list.search")}
                                maxLength={200}
                            />
                            {isLocalHost ? (
                                <SegmentedControl<OwnerFilter>
                                    size="sm"
                                    value={owner}
                                    onValueChange={(value) => narrow(() => setOwner(value))}
                                    aria-label={t("list.ownerLabel")}
                                    options={[
                                        { value: "all", label: t("list.owner.all") },
                                        { value: "polaris", label: t("list.owner.polaris") },
                                        { value: "other", label: t("list.owner.other") }
                                    ]}
                                />
                            ) : null}
                            <Select
                                value={stateFilter}
                                onValueChange={(value) =>
                                    narrow(() => setStateFilter(value as StateFilter))
                                }
                                aria-label={t("list.stateLabel")}
                                className="w-40"
                                options={STATE_FILTERS.map((value) => ({
                                    value,
                                    label: t(`list.state.${value}`)
                                }))}
                            />
                        </div>

                        <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-xs text-muted-foreground">
                                {statusLabel}
                            </span>
                            <div className="flex items-center gap-2">
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setLive((value) => !value)}
                                >
                                    {live ? t("live.pause") : t("live.resume")}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={refresh}
                                    disabled={loading}
                                >
                                    <RefreshCw className="size-4" />
                                    {t("live.refresh")}
                                </Button>
                            </div>
                        </div>

                        <div className="overflow-x-auto rounded-lg border border-border">
                            <table className="w-full min-w-[44rem] text-sm">
                                <thead className="bg-surface/60 text-start text-xs text-muted-foreground">
                                    <tr>
                                        <SortHeader
                                            label={t("columns.container")}
                                            order="name"
                                            sort={sort}
                                            onSort={sortBy}
                                        />
                                        <SortHeader
                                            label={t("columns.state")}
                                            order="state"
                                            sort={sort}
                                            onSort={sortBy}
                                        />
                                        <SortHeader
                                            label={t("columns.cpu")}
                                            order="cpu"
                                            sort={sort}
                                            onSort={sortBy}
                                        />
                                        <SortHeader
                                            label={t("columns.memory")}
                                            order="memory"
                                            sort={sort}
                                            onSort={sortBy}
                                        />
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
                                                {filtered ? (
                                                    <>
                                                        {t("list.noMatch")}
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            className="ms-2"
                                                            onClick={clearFilters}
                                                        >
                                                            {t("list.clear")}
                                                        </Button>
                                                    </>
                                                ) : (
                                                    t("empty.noContainers")
                                                )}
                                            </td>
                                        </tr>
                                    ) : (
                                        containers.map((container) => {
                                            const actions = rowActions(container);
                                            return (
                                                <RowContextMenu
                                                    key={container.id}
                                                    title={container.name}
                                                    actions={actions}
                                                >
                                                    <tr className="border-t border-border hover:bg-card-hover">
                                                        <td className="max-w-0 px-3 py-2">
                                                            <div className="flex min-w-0 items-center gap-2">
                                                                <Link
                                                                    href={containerHref(
                                                                        container,
                                                                        "details"
                                                                    )}
                                                                    className="min-w-0 truncate text-start font-medium hover:underline"
                                                                    title={container.name}
                                                                >
                                                                    {container.name}
                                                                </Link>
                                                                {container.polaris ? (
                                                                    <Badge
                                                                        variant="neutral"
                                                                        className="shrink-0"
                                                                    >
                                                                        {t("list.badge")}
                                                                    </Badge>
                                                                ) : null}
                                                            </div>
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
                                                                    stateGroup(container.state) ===
                                                                    "running"
                                                                        ? "success"
                                                                        : "neutral"
                                                                }
                                                            >
                                                                {containerStateLabel(
                                                                    t,
                                                                    container.state
                                                                )}
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
                                                                    : formatBytes(
                                                                          container.memUsage
                                                                      )
                                                            }
                                                        />
                                                        <td className="w-12 px-3 py-2 text-end">
                                                            <RowActionsMenu
                                                                title={container.name}
                                                                label={t("list.menu", {
                                                                    name: container.name
                                                                })}
                                                                actions={actions}
                                                            />
                                                        </td>
                                                    </tr>
                                                </RowContextMenu>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>
                        {snapshot && containers.length > 0 ? (
                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                                <span>
                                    {t("list.showing", { shown: containers.length, matched })}
                                </span>
                                {matched > containers.length ? (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={filtering}
                                        onClick={() => setLimit((held) => held + PAGE_SIZE)}
                                    >
                                        {t("list.more")}
                                    </Button>
                                ) : null}
                            </div>
                        ) : null}
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
    const t = useTranslations("containers");
    return (
        <>
            <Stat
                icon={<Boxes className="size-4" />}
                label={t("overview.containers")}
                value={`${overview.running}/${overview.containers}`}
                hint={t("overview.runningTotal")}
            />
            <Stat
                icon={<Cpu className="size-4" />}
                label={t("overview.cpu")}
                value={sampled ? `${overview.aggregateCpuPercent}%` : null}
                hint={t("overview.cores", { count: overview.ncpu })}
            />
            <Stat
                icon={<MemoryStick className="size-4" />}
                label={t("overview.memory")}
                value={sampled ? formatBytes(overview.aggregateMemUsage) : null}
                hint={t("overview.of", { total: formatBytes(overview.memTotal) })}
            />
            <Stat
                icon={<Server className="size-4" />}
                label={t("overview.engine")}
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
