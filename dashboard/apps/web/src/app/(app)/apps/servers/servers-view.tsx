"use client";

/**
 * Every server Polaris manages: the box it runs on - always listed first and never
 * removable - plus the SSH hosts registered for Containers (Docker) and Drive
 * (SFTP). Each row carries where the server lives, because that decides how a
 * domain is pointed at it; a server Polaris could not classify is flagged so the
 * operator answers before exposing anything. Delete uses an inline two-step
 * confirm (no native dialog).
 *
 * Whether a server is answering is not part of the page render. It is a TCP
 * handshake per server, so it is polled from the client and folded in as it
 * arrives - the table is on screen either way, and the local machine's own name
 * comes back on the same poll.
 */

import Link from "next/link";
import { HostDialog } from "./host-dialog";
import { useRouter } from "next/navigation";
import { QuickEnroll } from "./quick-enroll";
import { deleteHostAction } from "./actions";
import { ServerDialog } from "./server-dialog";
import { ENVIRONMENT_META } from "./environment-meta";
import { TerminalPanel } from "../deploy/terminal-panel";
import { useEffect, useState, useTransition } from "react";
import { useLiveResource } from "@/components/use-live-resource";
import type { ServerRow, ServerStatus, ServerStatusPayload } from "./types";
import { EnvironmentDialog, type EnvironmentTarget } from "./environment-dialog";
import { FolderOpen, MapPin, Server, Settings2, SquareTerminal, Trash2, TriangleAlert } from "lucide-react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Skeleton
} from "@polaris/ui";

/** How often reachability is re-checked. A server going down is worth noticing
 *  while the page is open, and each pass is one short-lived socket per server. */
const STATUS_POLL_MS = 30_000;

export function ServersView({ servers }: { servers: ServerRow[] }) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [target, setTarget] = useState<EnvironmentTarget | null>(null);
    const [shell, setShell] = useState<ServerRow | null>(null);
    const [details, setDetails] = useState<ServerRow | null>(null);
    const [enrollLocal, setEnrollLocal] = useState(false);

    const { data: live } = useLiveResource<ServerStatusPayload>({
        url: "/api/servers/status",
        cacheKey: "servers.status",
        intervalMs: STATUS_POLL_MS,
        select: (body) => body as ServerStatusPayload
    });
    const statusOf = (id: string): ServerStatus | null =>
        live?.servers.find((entry) => entry.id === id) ?? null;

    const unset = servers.filter((server) => server.environment === "unknown");
    const remotes = servers.filter((server) => server.kind === "host");

    function onDelete(id: string) {
        startTransition(async () => {
            await deleteHostAction(id);
            setConfirmId(null);
            router.refresh();
        });
    }

    function askEnvironment(server: ServerRow) {
        setTarget({
            hostId: server.kind === "host" ? server.id : null,
            name: server.name,
            current: server.environment,
            wildcardDomain: server.wildcardDomain,
            suggested: server.suggested,
            confirmed: server.confirmed
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-muted-foreground">Servers</h2>
                <HostDialog />
            </div>

            {unset.length > 0 ? (
                <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    Set where{" "}
                    {unset.length === 1 ? (
                        <b className="font-medium text-foreground">{unset[0]!.name}</b>
                    ) : (
                        `${unset.length} servers`
                    )}{" "}
                    {unset.length === 1 ? "lives" : "live"}: a home server behind a router and a data-centre box are
                    exposed in different ways, so Polaris needs the answer before it can tell you how to point a domain.
                </p>
            ) : null}

            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">Server</th>
                            <th className="px-3 py-2 font-medium">Address</th>
                            <th className="px-3 py-2 font-medium">Answering</th>
                            <th className="px-3 py-2 font-medium">Location</th>
                            <th className="px-3 py-2 font-medium">Auth</th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {servers.map((server) => (
                            <tr key={server.id} className="border-t border-border hover:bg-card-hover">
                                <td className="px-3 py-2">
                                    <button
                                        type="button"
                                        onClick={() => setDetails(server)}
                                        aria-label={`Open ${server.name}`}
                                        className="flex items-center gap-2 font-medium hover:underline"
                                    >
                                        <Server className="size-4 text-muted-foreground" />
                                        {server.name}
                                        {server.kind === "local" ? <Badge variant="primary">This machine</Badge> : null}
                                    </button>
                                    <span className="block text-xs text-muted-foreground">
                                        {server.kind === "host" ? (
                                            server.detail
                                        ) : live?.machineName ? (
                                            live.machineName
                                        ) : (
                                            // Its own name is on the way; hold the line's
                                            // height so the row does not jump when it lands.
                                            <Skeleton className="mt-0.5 inline-block h-3 w-24 align-middle" />
                                        )}
                                    </span>
                                </td>
                                <td className="px-3 py-2 text-muted-foreground">
                                    {server.address}
                                    {server.port ? `:${server.port}` : ""}
                                </td>
                                <td className="px-3 py-2">
                                    <StatusCell kind={server.kind} status={statusOf(server.id)} />
                                </td>
                                <td className="px-3 py-2">
                                    <EnvironmentCell server={server} onPick={() => askEnvironment(server)} />
                                </td>
                                <td className="px-3 py-2">
                                    <div className="flex flex-wrap items-center gap-1">
                                        {server.authMethod ? (
                                            <Badge variant="neutral">{server.authMethod}</Badge>
                                        ) : (
                                            <span className="text-xs text-muted-foreground">Local</span>
                                        )}
                                        {/* Root is worth its own badge: it is the widest thing a
                                            server can have granted, and a server that has it should
                                            never be one anybody has to go and check. */}
                                        {server.sudo ? <Badge variant="warning">Root</Badge> : null}
                                    </div>
                                </td>
                                <td className="px-3 py-2">
                                    <div className="flex justify-end gap-1">
                                        {confirmId === server.id ? (
                                            <>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => setConfirmId(null)}
                                                    disabled={pending}
                                                >
                                                    Cancel
                                                </Button>
                                                {/* The Host, not the row: the local row's own id is
                                                    a placeholder, and what is being given up is the
                                                    login behind it. */}
                                                <Button
                                                    size="sm"
                                                    onClick={() => onDelete(server.hostId ?? server.id)}
                                                    disabled={pending}
                                                >
                                                    Remove
                                                </Button>
                                            </>
                                        ) : (
                                            <>
                                                {server.hostId ? (
                                                    <>
                                                        <Button
                                                            size="icon"
                                                            variant="ghost"
                                                            aria-label={`Open a shell on ${server.name}`}
                                                            title="Open a shell"
                                                            onClick={() => setShell(server)}
                                                        >
                                                            <SquareTerminal className="size-4" />
                                                        </Button>
                                                        <Button size="icon" variant="ghost" asChild>
                                                            <Link
                                                                href={`/drive?c=host:${server.hostId}`}
                                                                aria-label={`Browse the files on ${server.name}`}
                                                                title="Browse its files"
                                                            >
                                                                <FolderOpen className="size-4" />
                                                            </Link>
                                                        </Button>
                                                    </>
                                                ) : server.kind === "local" ? (
                                                    // Polaris reaches its own machine through the container
                                                    // engine only, so a shell there has to be granted the
                                                    // same way any other server grants one.
                                                    <Button size="sm" variant="secondary" onClick={() => setEnrollLocal(true)}>
                                                        <SquareTerminal className="size-3.5" /> Enable shell and files
                                                    </Button>
                                                ) : null}
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    aria-label={`Rename ${server.name} and see how to connect to it`}
                                                    title="Name and connection details"
                                                    onClick={() => setDetails(server)}
                                                >
                                                    <Settings2 className="size-4" />
                                                </Button>
                                                {/* The local machine is never removed - it is the
                                                    box Polaris runs on - but the login it was
                                                    reached by can be given back. */}
                                                {server.kind === "host" || server.hostId ? (
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        aria-label={
                                                            server.kind === "local"
                                                                ? `Stop reaching ${server.name} over SSH`
                                                                : `Remove ${server.name}`
                                                        }
                                                        title={server.kind === "local" ? "Give up the login" : "Remove"}
                                                        onClick={() => setConfirmId(server.id)}
                                                    >
                                                        <Trash2 className="size-4" />
                                                    </Button>
                                                ) : null}
                                            </>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {remotes.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    Add a server to reach it from Containers (Docker), Drive (SFTP) and a shell here.
                </p>
            ) : null}

            <EnvironmentDialog target={target} onClose={() => setTarget(null)} />
            <ShellDialog server={shell} onClose={() => setShell(null)} />
            <Dialog open={enrollLocal} onOpenChange={setEnrollLocal}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Reach this machine</DialogTitle>
                        <DialogDescription>
                            Run this on the machine Polaris runs on to give it a shell, its files, and a login to
                            run jobs under.
                        </DialogDescription>
                    </DialogHeader>
                    <QuickEnroll kind="local" onDone={() => setEnrollLocal(false)} />
                </DialogContent>
            </Dialog>
            <ServerDialog
                server={details}
                status={details ? statusOf(details.id) : null}
                machineName={live?.machineName ?? null}
                onRenamed={() => {
                    setDetails(null);
                    router.refresh();
                }}
                onClose={() => setDetails(null)}
            />
        </div>
    );
}

/** Reachability, or the fact that it has not been checked yet. The local box is
 *  the machine answering the request, so it is stated rather than probed. */
function StatusCell({ kind, status }: { kind: ServerRow["kind"]; status: ServerStatus | null }) {
    if (kind === "local") return <Badge variant="success">Up</Badge>;
    if (!status) return <span className="text-xs text-muted-foreground">Checking...</span>;
    if (status.state === "down") {
        return (
            <Badge variant="danger" title={status.detail ?? undefined}>
                No answer
            </Badge>
        );
    }
    return <Badge variant="success">{status.latencyMs === null ? "Up" : `${status.latencyMs} ms`}</Badge>;
}

/**
 * A shell on one server. Mounted only while open so closing the dialog tears the
 * SSH session down rather than leaving it attached in the background.
 *
 * Root is offered only where the enrollment granted it, and switching restarts the
 * session rather than escalating an open one - the panel is keyed on which of the
 * two it is, so there is never a terminal whose prompt disagrees with its label.
 */
function ShellDialog({ server, onClose }: { server: ServerRow | null; onClose: () => void }) {
    const [asRoot, setAsRoot] = useState(false);

    // A different server may not offer root at all; starting each one as the login
    // means the widest option is never the one that opens by default.
    useEffect(() => {
        setAsRoot(false);
    }, [server?.id]);

    return (
        <Dialog open={server !== null} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        {server?.name}
                        {asRoot ? <Badge variant="warning">root</Badge> : null}
                    </DialogTitle>
                    <DialogDescription>
                        {server
                            ? asRoot
                                ? `Signed in as ${server.detail} over SSH, elevated with sudo.`
                                : `Signed in as ${server.detail} over SSH.`
                            : null}
                    </DialogDescription>
                </DialogHeader>

                {server?.sudo ? (
                    <div className="flex justify-end">
                        <Button size="sm" variant="ghost" onClick={() => setAsRoot((current) => !current)}>
                            {asRoot ? `Back to ${server.detail}` : "Open as root"}
                        </Button>
                    </div>
                ) : null}

                {server ? (
                    <TerminalPanel
                        key={asRoot ? "root" : "login"}
                        target={{ kind: "host", hostId: server.hostId ?? server.id, asRoot }}
                        label={`${asRoot ? "root" : server.detail}@${server.address}`}
                    />
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

/** The location cell: a clickable badge, or a call to action when it is unset. */
function EnvironmentCell({ server, onPick }: { server: ServerRow; onPick: () => void }) {
    const meta = ENVIRONMENT_META[server.environment];

    if (server.environment === "unknown") {
        return (
            <Button size="sm" variant="secondary" onClick={onPick}>
                <MapPin className="size-3.5" /> Set location
            </Button>
        );
    }

    return (
        <button
            type="button"
            onClick={onPick}
            aria-label={`Change where ${server.name} lives`}
            className="flex items-center gap-2"
        >
            <Badge variant={meta.tone}>{meta.label}</Badge>
            {/* Detected but never confirmed: say so rather than pass a guess off as settled. */}
            {server.confirmed ? null : <span className="text-xs text-muted-foreground">detected</span>}
        </button>
    );
}
