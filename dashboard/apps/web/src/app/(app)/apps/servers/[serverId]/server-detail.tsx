"use client";

/**
 * One server, opened.
 *
 * A server carries as much as a container does - what it is running, what that is
 * costing it, how to reach it, what removing it would take with it - and a dialog
 * over the table was never the place for it: half of that could not fit, and none
 * of it had an address anybody could send.
 *
 * The page paints from what is already known (name, address, auth, location) and
 * everything that needs the machine arrives after: whether it answers, what is
 * eating it, and its load over time. So a server that is off still opens, and says
 * so, rather than hanging on a shell that will not connect.
 */

import Link from "next/link";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ServerUsage } from "../server-usage";
import { ServerStorage } from "../server-storage";
import { ServerWorkload } from "./server-workload";
import { ServerNotesPanel } from "../server-notes-panel";
import { ENVIRONMENT_META } from "../environment-meta";
import type { ServerMetrics } from "@/lib/server-probe";
import { RemoveServerDialog } from "../remove-server-dialog";
import { useLiveResource } from "@/components/use-live-resource";
import { TerminalPanel } from "@/app/(app)/apps/deploy/terminal-panel";
import type { ServerRow, ServerStatus, ServerStatusPayload } from "../types";
import { Connect, LocalNote, LocalPathPanel, Reachability, RenameForm } from "../server-panels";
import { EnvironmentDialog, type EnvironmentTarget } from "../environment-dialog";
import { CONSUMPTION_METRICS, MetricsHistory } from "@/components/metrics-history";
import { ArrowLeft, Boxes, FolderOpen, MapPin, SquareTerminal, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

/** The same cadence the table polls at - a server going down is worth noticing
 *  while its own page is open. */
const STATUS_POLL_MS = 30_000;

const TABS = [
    { id: "overview", label: "Overview" },
    // What the Storage figure on the overview is actually made of. Only for the
    // machine Polaris runs on: it is the one it can reach through its own daemon
    // to say what is on the disk, let alone take anything off it.
    { id: "storage", label: "Storage", needsLocal: true },
    { id: "connection", label: "Connection" },
    // Only a registered server has an id to hang a history on: the box Polaris
    // runs on has no Host row until it is enrolled.
    { id: "notes", label: "Notes", needsHost: true }
] as const;

type TabId = (typeof TABS)[number]["id"];

/** The tab a link can point at, so "where did the room go" is an address rather
 *  than a click somebody has to be told to make. */
function tabFromQuery(value: string | null): TabId | null {
    return TABS.some((tab) => tab.id === value) ? (value as TabId) : null;
}

export function ServerDetail({
    server,
    connectionId,
    metricsId,
    machineName,
    initialUsage
}: {
    server: ServerRow;
    /** What the box calls itself, resolved on the server so the line under the
     *  name is complete on the first paint rather than growing a clause a
     *  moment later. The live payload replaces it if the engine disagrees. */
    machineName: string;
    /** How the Containers app reaches this machine's engine, so its containers can
     *  be listed and linked. */
    connectionId: string;
    /** How its load history is addressed. The machine Polaris runs on is measured
     *  directly rather than over SSH to itself, so it is `local` even when it also
     *  has a server row. */
    metricsId: string;
    /** The reading the server already had of this machine, for the first paint. */
    initialUsage?: { at: number; value: ServerMetrics };
}) {
    const router = useRouter();
    const query = useSearchParams();
    const [tab, setTab] = useState<TabId>(() => tabFromQuery(query.get("tab")) ?? "overview");
    const [shellOpen, setShellOpen] = useState(false);
    const [asRoot, setAsRoot] = useState(false);
    const [location, setLocation] = useState<EnvironmentTarget | null>(null);
    const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

    const { data: live } = useLiveResource<ServerStatusPayload>({
        url: "/api/servers/status",
        cacheKey: "servers.status",
        intervalMs: STATUS_POLL_MS,
        select: (body) => body as ServerStatusPayload
    });
    const status: ServerStatus | null =
        live?.servers.find((entry) => entry.id === server.id) ?? null;
    // Only a machine that answered with a refusal or a timeout is treated as down;
    // one that has not been probed yet keeps its actions.
    const down = status?.state === "down";
    const meta = ENVIRONMENT_META[server.environment];
    // How to reach it, said once: the paragraph under the name draws it, and the
    // same string is what the tooltip hands back when that paragraph clips.
    const reach =
        server.kind === "local"
            ? `The machine Polaris runs on, ${live?.machineName ?? machineName}`
            : `${server.detail}@${server.address}${server.port ? `:${server.port}` : ""}`;

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <Link
                        href="/apps/servers"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                        <ArrowLeft className="size-3" /> Servers
                    </Link>
                    <h1
                        title={server.name}
                        className="mt-1 flex flex-wrap items-center gap-2 truncate text-[1.0625rem] font-semibold tracking-tight"
                    >
                        {server.name}
                        {server.kind === "local" ? (
                            <Badge variant="primary">This machine</Badge>
                        ) : null}
                        {server.sudo ? <Badge variant="warning">Root</Badge> : null}
                    </h1>
                    <p
                        title={server.os ? `${reach} - ${server.os}` : reach}
                        className="truncate text-sm text-muted-foreground"
                    >
                        {reach}
                        {server.os ? (
                            <span className="ml-1.5 border-l border-border pl-1.5">
                                {server.os}
                            </span>
                        ) : null}
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-1">
                    <Button asChild variant="ghost" size="sm">
                        <Link href={`/apps/containers?c=${encodeURIComponent(connectionId)}`}>
                            <Boxes className="size-4" /> Containers
                        </Link>
                    </Button>
                    {server.hostId ? (
                        <>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={down}
                                title={down ? "Not answering over SSH" : "Open a shell"}
                                onClick={() => setShellOpen(true)}
                            >
                                <SquareTerminal className="size-4" /> Shell
                            </Button>
                            <Button asChild variant="ghost" size="sm" disabled={down}>
                                <Link href={`/drive?c=host:${server.hostId}`}>
                                    <FolderOpen className="size-4" /> Files
                                </Link>
                            </Button>
                        </>
                    ) : null}
                </div>
            </div>

            <div className="flex gap-1 border-b border-border/60">
                {TABS.filter(
                    (entry) =>
                        (!("needsHost" in entry) || server.hostId) &&
                        (!("needsLocal" in entry) || server.kind === "local")
                ).map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        onClick={() => setTab(entry.id)}
                        aria-current={tab === entry.id ? "page" : undefined}
                        className={cn(
                            "-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors",
                            tab === entry.id
                                ? "border-primary font-medium text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {entry.label}
                    </button>
                ))}
            </div>

            {tab === "notes" && server.hostId ? (
                <ServerNotesPanel hostId={server.hostId} />
            ) : tab === "storage" && server.kind === "local" ? (
                <ServerStorage />
            ) : tab === "overview" ? (
                <div className="flex flex-col gap-5">
                    <Reachability server={server} status={status} />

                    {/* Only where there is a machine to ask. The box Polaris runs
                        on is already as near as anything gets. */}
                    {server.kind === "local" ? null : <LocalPathPanel server={server} />}

                    {/* The whole machine, including everything that is not a
                        container. It needs a login on the box, so it is offered
                        only where there is one. */}
                    {server.hostId ? (
                        <ServerUsage
                            key={server.hostId}
                            hostId={server.hostId}
                            initial={initialUsage}
                        />
                    ) : null}

                    <ServerWorkload connectionId={connectionId} />

                    <section className="flex flex-col gap-1">
                        <h2 className="text-sm font-medium">Load</h2>
                        <MetricsHistory
                            endpoint={`/api/watch/hosts/${encodeURIComponent(metricsId)}/metrics/history`}
                            metrics={CONSUMPTION_METRICS}
                        />
                        <p className="text-xs text-muted-foreground">
                            Measured from the containers running on this server, against what the
                            machine has.{" "}
                            {/* The Storage figure is the one people arrive at with a
                                question the chart cannot answer: 89 GB of what. */}
                            {server.kind === "local" ? (
                                <button
                                    type="button"
                                    onClick={() => setTab("storage")}
                                    className="text-primary hover:underline"
                                >
                                    See what is taking up the disk
                                </button>
                            ) : null}
                        </p>
                    </section>
                </div>
            ) : (
                <div className="flex flex-col gap-5">
                    <RenameForm server={server} onRenamed={() => router.refresh()} />

                    <section className="flex flex-col gap-2">
                        <h2 className="text-sm font-medium">Location</h2>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() =>
                                    setLocation({
                                        hostId: server.kind === "host" ? server.id : null,
                                        name: server.name,
                                        current: server.environment,
                                        wildcardDomain: server.wildcardDomain,
                                        suggested: server.suggested,
                                        confirmed: server.confirmed
                                    })
                                }
                            >
                                <MapPin className="size-3.5" />
                                {server.environment === "unknown" ? "Set location" : meta.label}
                            </Button>
                            {server.environment !== "unknown" && !server.confirmed ? (
                                <span className="text-xs text-muted-foreground">detected</span>
                            ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            A home server behind a router and a data-center box are exposed in
                            different ways, so this decides how a domain is pointed at it.
                        </p>
                    </section>

                    <section className="flex flex-col gap-2">
                        <h2 className="text-sm font-medium">Reach it yourself</h2>
                        {server.kind === "local" && !server.hostId ? (
                            <LocalNote />
                        ) : (
                            <Connect server={server} />
                        )}
                    </section>

                    {server.hostId ? (
                        <section className="flex flex-col gap-2">
                            <h2 className="text-sm font-medium">
                                {server.kind === "local"
                                    ? "Give up the login"
                                    : "Remove this server"}
                            </h2>
                            <p className="text-xs text-muted-foreground">
                                {server.kind === "local"
                                    ? "The machine Polaris runs on stays listed. Only the SSH login it was enrolled with is given back, so the shell and its files stop being offered here."
                                    : "What this would take with it is worked out first, and anything deployed here can be moved to another server rather than lost."}
                            </p>
                            <div>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() =>
                                        setRemoving({ id: server.hostId!, name: server.name })
                                    }
                                >
                                    <Trash2 className="size-3.5" />
                                    {server.kind === "local" ? "Give up the login" : "Remove"}
                                </Button>
                            </div>
                        </section>
                    ) : null}
                </div>
            )}

            <EnvironmentDialog target={location} onClose={() => setLocation(null)} />
            <RemoveServerDialog
                server={removing}
                onClose={() => setRemoving(null)}
                onRemoved={() => router.push("/apps/servers")}
            />

            {/* Mounted only while open, so closing it tears the SSH session down
                rather than leaving one attached in the background. */}
            <Dialog open={shellOpen} onOpenChange={setShellOpen}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            {server.name}
                            {asRoot ? <Badge variant="warning">root</Badge> : null}
                        </DialogTitle>
                    </DialogHeader>
                    {server.sudo ? (
                        <DialogFooter>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setAsRoot((current) => !current)}
                            >
                                {asRoot ? `Back to ${server.detail}` : "Open as root"}
                            </Button>
                        </DialogFooter>
                    ) : null}
                    {shellOpen ? (
                        <TerminalPanel
                            key={asRoot ? "root" : "login"}
                            target={{ kind: "host", hostId: server.hostId ?? server.id, asRoot }}
                            label={`${asRoot ? "root" : server.detail}@${server.address}`}
                        />
                    ) : null}
                </DialogContent>
            </Dialog>
        </div>
    );
}
