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
 * comes back on the same poll. Once it says a server is down, the actions that
 * need the machine - a shell, its files - are disabled rather than left to open
 * and time out.
 */

import Link from "next/link";
import { HostDialog } from "./host-dialog";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { renameServerAction } from "./actions";
import { useEffect, useRef, useState } from "react";
import { QuickEnroll } from "./quick-enroll";
import { ServerGroups } from "./server-groups";
import { ENVIRONMENT_META } from "./environment-meta";
import { TerminalPanel } from "../deploy/terminal-panel";
import { RemoveServerDialog } from "./remove-server-dialog";
import { useLiveResource } from "@/components/use-live-resource";
import type { RemoveServerResult } from "@/lib/server-removal-service";
import type { ServerRow, ServerStatus, ServerStatusPayload } from "./types";
import { EnvironmentDialog, type EnvironmentTarget } from "./environment-dialog";
import {
    Copy,
    FolderOpen,
    MapPin,
    Pencil,
    Server,
    Settings2,
    SquareTerminal,
    Trash2,
    TriangleAlert
} from "lucide-react";
import {
    Badge,
    Button,
    cn,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    keepFocusOnClose,
    MenuShortcut,
    useDeferredFocus
} from "@polaris/ui";

/** How often reachability is re-checked. A server going down is worth noticing
 *  while the page is open, and each pass is one short-lived socket per server. */
const STATUS_POLL_MS = 30_000;

export function ServersView({
    servers,
    machineName
}: {
    servers: ServerRow[];
    /** What the box calls itself, resolved on the server so the row is complete
     *  on the first paint. The live payload replaces it if the container engine
     *  reports something else. */
    machineName: string;
}) {
    const router = useRouter();
    const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
    const [outcome, setOutcome] = useState<RemoveServerResult | null>(null);
    const [target, setTarget] = useState<EnvironmentTarget | null>(null);
    const [shell, setShell] = useState<ServerRow | null>(null);
    const [enrollLocal, setEnrollLocal] = useState(false);
    /** The row somebody clicked, which the keys act on when nothing is hovered. */
    const [selected, setSelected] = useState<string | null>(null);
    /** The row under the pointer, which the keys act on first - the way a file
     *  manager answers F2 over the thing being pointed at. */
    const hovered = useRef<string | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    /** Names already saved here, shown before the page has been read again. */
    const [renamed, setRenamed] = useState<Record<string, string>>({});
    const [renameError, setRenameError] = useState<string | null>(null);

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

    const nameOf = (server: ServerRow): string => renamed[server.id] ?? server.name;

    // F2 renames and Delete asks to remove, on the row pointed at or else the one
    // selected. Listened for on the document, so pointing is enough - but never
    // while somebody is typing, or while a dialog is in front of the table.
    useEffect(() => {
        function onKeyDown(event: KeyboardEvent): void {
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
            if (event.key !== "F2" && event.key !== "Delete") return;
            const target = event.target as HTMLElement | null;
            if (
                target?.closest(
                    "input, textarea, select, [contenteditable='true'], [role='dialog']"
                )
            ) {
                return;
            }
            const row = servers.find((server) => server.id === (hovered.current ?? selected));
            if (!row) return;
            if (event.key === "F2") {
                event.preventDefault();
                setRenameError(null);
                setRenaming(row.id);
            } else if (row.hostId) {
                event.preventDefault();
                setRemoving({ id: row.hostId, name: nameOf(row) });
            }
        }
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    });

    /**
     * Save a name typed into a row. Shown at once and put back if the server
     * refuses it. A registered server has to be called something; the local box
     * cleared goes back to what the machine calls itself.
     */
    async function rename(server: ServerRow, value: string): Promise<void> {
        setRenaming(null);
        const clean = value.trim();
        const local = server.kind === "local";
        if (clean === nameOf(server) || (!local && clean.length === 0)) return;
        const before = renamed[server.id];
        setRenamed((current) => ({
            ...current,
            [server.id]: clean || (live?.machineName ?? machineName)
        }));
        setRenameError(null);
        const result = await runAction(
            () => renameServerAction({ hostId: local ? null : server.id, name: clean }),
            setRenameError
        );
        if (!result || result.error) {
            setRenamed((current) => {
                const next = { ...current };
                if (before === undefined) delete next[server.id];
                else next[server.id] = before;
                return next;
            });
            if (result?.error) setRenameError(result.error);
            return;
        }
        router.refresh();
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
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-muted-foreground">Servers</h2>
                <HostDialog />
            </div>

            {/* What the removal could not finish on the machine itself. The row is
                already gone by now, so there is nowhere else for this to be said -
                and "the login is still authorized over there" is exactly the kind
                of thing that must not be swallowed. */}
            {outcome ? (
                <RemovalOutcome result={outcome} onDismiss={() => setOutcome(null)} />
            ) : null}

            {unset.length > 0 ? (
                <p className="flex items-start gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    Set where{" "}
                    {unset.length === 1 ? (
                        <b className="font-medium text-foreground">{unset[0]!.name}</b>
                    ) : (
                        `${unset.length} servers`
                    )}{" "}
                    {unset.length === 1 ? "lives" : "live"}: a home server behind a router and a
                    data-center box are exposed in different ways, so Polaris needs the answer
                    before it can tell you how to point a domain.
                </p>
            ) : null}

            {renameError ? (
                <p role="alert" className="text-xs text-danger">
                    {renameError}
                </p>
            ) : null}

            <div className="overflow-x-auto rounded-lg border border-border">
                {/* Six columns of address, status and auth do not compress into a phone,
                    so the table keeps its width and the wrapper scrolls instead. */}
                <table className="w-full min-w-[46rem] text-sm">
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
                        {servers.map((server) => {
                            const status = statusOf(server.id);
                            // Only a machine that answered the probe with a
                            // refusal or a timeout is treated as down; one that
                            // has not been probed yet keeps its actions.
                            const down = status?.state === "down";
                            const name = nameOf(server);
                            const address = `${server.address}${server.port ? `:${server.port}` : ""}`;
                            return (
                                <ContextMenu
                                    key={server.id}
                                    onOpenChange={(open) => {
                                        if (open) setSelected(server.id);
                                    }}
                                >
                                    <ContextMenuTrigger asChild>
                                        <tr
                                            aria-selected={selected === server.id}
                                            tabIndex={0}
                                            onPointerEnter={() => {
                                                hovered.current = server.id;
                                            }}
                                            onPointerLeave={() => {
                                                if (hovered.current === server.id)
                                                    hovered.current = null;
                                            }}
                                            onFocus={() => setSelected(server.id)}
                                            onClick={() => setSelected(server.id)}
                                            className={cn(
                                                "border-t border-border outline-none hover:bg-card-hover focus-visible:bg-card-hover",
                                                selected === server.id && "bg-muted"
                                            )}
                                        >
                                            <td className="px-3 py-2">
                                                {renaming === server.id ? (
                                                    <RenameField
                                                        name={name}
                                                        placeholder={
                                                            server.kind === "local"
                                                                ? (live?.machineName ?? machineName)
                                                                : undefined
                                                        }
                                                        onDone={(value) =>
                                                            value === null
                                                                ? setRenaming(null)
                                                                : void rename(server, value)
                                                        }
                                                    />
                                                ) : (
                                                    <Link
                                                        href={`/apps/servers/${server.id}`}
                                                        aria-label={`Open ${name}`}
                                                        title="Right-click for more, F2 to rename"
                                                        className="flex items-center gap-2 font-medium hover:underline"
                                                    >
                                                        <Server className="size-4 text-muted-foreground" />
                                                        {name}
                                                        {server.kind === "local" ? (
                                                            <Badge variant="primary">
                                                                This machine
                                                            </Badge>
                                                        ) : null}
                                                    </Link>
                                                )}
                                                <span className="block text-xs text-muted-foreground">
                                                    {/* The hostname the server render
                                                already knew, replaced by what the
                                                engine reports if the two differ.
                                                There is nothing to wait for here,
                                                and a skeleton under the name of
                                                the machine it is about was a
                                                loading state for a fact that does
                                                not change. */}
                                                    {server.kind === "host"
                                                        ? server.detail
                                                        : (live?.machineName ?? machineName)}
                                                    {/* On this line rather than in a column of its own: the
                                                table already carries six, and a seventh is what makes
                                                it unreadable on a laptop. */}
                                                    {server.os ? (
                                                        <span className="ml-1.5 border-l border-border pl-1.5">
                                                            {server.os}
                                                        </span>
                                                    ) : null}
                                                </span>
                                            </td>
                                            <td className="px-3 py-2 text-muted-foreground">
                                                {address}
                                            </td>
                                            <td className="px-3 py-2">
                                                <StatusCell kind={server.kind} status={status} />
                                            </td>
                                            <td className="px-3 py-2">
                                                <EnvironmentCell
                                                    server={server}
                                                    onPick={() => askEnvironment(server)}
                                                />
                                            </td>
                                            <td className="px-3 py-2">
                                                <div className="flex flex-wrap items-center gap-1">
                                                    {server.authMethod ? (
                                                        <Badge variant="neutral">
                                                            {server.authMethod}
                                                        </Badge>
                                                    ) : (
                                                        <span className="text-xs text-muted-foreground">
                                                            Local
                                                        </span>
                                                    )}
                                                    {/* Root is worth its own badge: it is the widest thing a
                                                server can have granted, and a server that has it should
                                                never be one anybody has to go and check. */}
                                                    {server.sudo ? (
                                                        <Badge variant="warning">Root</Badge>
                                                    ) : null}
                                                </div>
                                            </td>
                                            <td className="px-3 py-2">
                                                <div className="flex justify-end gap-1">
                                                    {server.hostId ? (
                                                        // A shell and its files both need the
                                                        // machine to answer, so neither is
                                                        // offered while it does not - the
                                                        // alternative is a button that opens a
                                                        // panel to watch it time out.
                                                        <>
                                                            <Button
                                                                size="icon"
                                                                variant="ghost"
                                                                disabled={down}
                                                                aria-label={`Open a shell on ${server.name}`}
                                                                title={
                                                                    down
                                                                        ? "Not answering over SSH"
                                                                        : "Open a shell"
                                                                }
                                                                onClick={() => setShell(server)}
                                                            >
                                                                <SquareTerminal className="size-4" />
                                                            </Button>
                                                            {down ? (
                                                                <Button
                                                                    size="icon"
                                                                    variant="ghost"
                                                                    disabled
                                                                    aria-label={`Browse the files on ${server.name}`}
                                                                    title="Not answering over SSH"
                                                                >
                                                                    <FolderOpen className="size-4" />
                                                                </Button>
                                                            ) : (
                                                                <Button
                                                                    size="icon"
                                                                    variant="ghost"
                                                                    asChild
                                                                >
                                                                    <Link
                                                                        href={`/drive?c=host:${server.hostId}`}
                                                                        aria-label={`Browse the files on ${server.name}`}
                                                                        title="Browse its files"
                                                                    >
                                                                        <FolderOpen className="size-4" />
                                                                    </Link>
                                                                </Button>
                                                            )}
                                                        </>
                                                    ) : server.kind === "local" ? (
                                                        // Polaris reaches its own machine through the container
                                                        // engine only, so a shell there has to be granted the
                                                        // same way any other server grants one.
                                                        <Button
                                                            size="sm"
                                                            variant="secondary"
                                                            onClick={() => setEnrollLocal(true)}
                                                        >
                                                            <SquareTerminal className="size-3.5" />{" "}
                                                            Enable shell and files
                                                        </Button>
                                                    ) : null}
                                                    <Button size="icon" variant="ghost" asChild>
                                                        <Link
                                                            href={`/apps/servers/${server.id}`}
                                                            aria-label={`Open ${server.name}`}
                                                            title="Usage, load and connection details"
                                                        >
                                                            <Settings2 className="size-4" />
                                                        </Link>
                                                    </Button>
                                                    {/* The local machine is never removed - it is the box
                                                Polaris runs on - but the login it was reached by can
                                                be given back. The Host, not the row: the local row's
                                                own id is a placeholder. */}
                                                    {server.hostId ? (
                                                        <Button
                                                            size="icon"
                                                            variant="ghost"
                                                            aria-label={
                                                                server.kind === "local"
                                                                    ? `Stop reaching ${server.name} over SSH`
                                                                    : `Remove ${server.name}`
                                                            }
                                                            title={
                                                                server.kind === "local"
                                                                    ? "Give up the login"
                                                                    : "Remove"
                                                            }
                                                            onClick={() =>
                                                                setRemoving({
                                                                    id: server.hostId ?? server.id,
                                                                    name: server.name
                                                                })
                                                            }
                                                        >
                                                            <Trash2 className="size-4" />
                                                        </Button>
                                                    ) : null}
                                                </div>
                                            </td>
                                        </tr>
                                    </ContextMenuTrigger>
                                    {/* The rename field it can open would lose its focus to
                                    the row the moment the menu closed. */}
                                    <ContextMenuContent onCloseAutoFocus={keepFocusOnClose}>
                                        <ContextMenuLabel>{name}</ContextMenuLabel>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem asChild>
                                            <Link href={`/apps/servers/${server.id}`}>
                                                <Settings2 className="size-4" /> Open
                                            </Link>
                                        </ContextMenuItem>
                                        {server.hostId ? (
                                            <>
                                                <ContextMenuItem
                                                    disabled={down}
                                                    onSelect={() => setShell(server)}
                                                >
                                                    <SquareTerminal className="size-4" /> Open a
                                                    shell
                                                    {down ? (
                                                        <span className="ml-auto pl-3 text-xs">
                                                            Not answering
                                                        </span>
                                                    ) : null}
                                                </ContextMenuItem>
                                                {down ? (
                                                    // A disabled item takes no pointer
                                                    // events, so it says why itself.
                                                    <ContextMenuItem disabled>
                                                        <FolderOpen className="size-4" /> Browse its
                                                        files
                                                        <span className="ml-auto pl-3 text-xs">
                                                            Not answering
                                                        </span>
                                                    </ContextMenuItem>
                                                ) : (
                                                    <ContextMenuItem asChild>
                                                        <Link
                                                            href={`/drive?c=host:${server.hostId}`}
                                                        >
                                                            <FolderOpen className="size-4" /> Browse
                                                            its files
                                                        </Link>
                                                    </ContextMenuItem>
                                                )}
                                            </>
                                        ) : server.kind === "local" ? (
                                            <ContextMenuItem onSelect={() => setEnrollLocal(true)}>
                                                <SquareTerminal className="size-4" /> Enable shell
                                                and files
                                            </ContextMenuItem>
                                        ) : null}
                                        <ContextMenuSeparator />
                                        <ContextMenuItem
                                            onSelect={() => {
                                                setRenameError(null);
                                                setRenaming(server.id);
                                            }}
                                        >
                                            <Pencil className="size-4" /> Rename
                                            <MenuShortcut>F2</MenuShortcut>
                                        </ContextMenuItem>
                                        <ContextMenuItem
                                            onSelect={() =>
                                                void navigator.clipboard?.writeText(address)
                                            }
                                        >
                                            <Copy className="size-4" /> Copy address
                                        </ContextMenuItem>
                                        <ContextMenuItem onSelect={() => askEnvironment(server)}>
                                            <MapPin className="size-4" /> Where it lives
                                        </ContextMenuItem>
                                        {server.hostId ? (
                                            <>
                                                <ContextMenuSeparator />
                                                <ContextMenuItem
                                                    variant="danger"
                                                    onSelect={() =>
                                                        setRemoving({
                                                            id: server.hostId ?? server.id,
                                                            name
                                                        })
                                                    }
                                                >
                                                    <Trash2 className="size-4" />
                                                    {server.kind === "local"
                                                        ? "Give up the login"
                                                        : "Remove"}
                                                    <MenuShortcut>Del</MenuShortcut>
                                                </ContextMenuItem>
                                            </>
                                        ) : null}
                                    </ContextMenuContent>
                                </ContextMenu>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {remotes.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    Add a server to reach it from Containers (Docker), Drive (SFTP) and a shell
                    here.
                </p>
            ) : null}

            <EnvironmentDialog target={target} onClose={() => setTarget(null)} />
            <ShellDialog server={shell} onClose={() => setShell(null)} />
            <RemoveServerDialog
                server={removing}
                onClose={() => setRemoving(null)}
                onRemoved={(result) => {
                    setOutcome(result);
                    router.refresh();
                }}
            />
            <Dialog open={enrollLocal} onOpenChange={setEnrollLocal}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Reach this machine</DialogTitle>
                        <DialogDescription>
                            Run this on the machine Polaris runs on to give it a shell, its files,
                            and a login to run jobs under.
                        </DialogDescription>
                    </DialogHeader>
                    <QuickEnroll kind="local" onDone={() => setEnrollLocal(false)} />
                </DialogContent>
            </Dialog>

            {/* Below the table, because a group is something you reach for once the
                machines exist - and it is the firewall that consumes it, not this
                screen. */}
            <ServerGroups servers={servers} />
        </div>
    );
}

/** How the removal went, once the server itself is off the list: what moved, and
 *  anything Polaris could not finish on the machine and the operator now owns. */
function RemovalOutcome({
    result,
    onDismiss
}: {
    result: RemoveServerResult;
    onDismiss: () => void;
}) {
    const moved = result.moved ?? [];
    const warnings = result.warnings ?? [];
    if (moved.length === 0 && warnings.length === 0) return null;
    return (
        <div
            className={`flex flex-col gap-1.5 rounded-md border px-3 py-2 text-xs ${
                warnings.length > 0
                    ? "border-warning-edge bg-warning-soft"
                    : "border-border bg-surface/60"
            }`}
        >
            <div className="flex items-start justify-between gap-2">
                <p className="text-muted-foreground">
                    {moved.length > 0
                        ? `Moved to the new server: ${moved.join(", ")}.`
                        : "The server was removed."}
                </p>
                <Button size="sm" variant="ghost" onClick={onDismiss}>
                    Dismiss
                </Button>
            </div>
            {warnings.map((warning) => (
                <p key={warning} className="flex items-start gap-2 text-foreground/80">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    {warning}
                </p>
            ))}
        </div>
    );
}

/**
 * A server's name, being typed. Enter or leaving the field saves, Escape puts it
 * back. Keys typed here stay here: the row around it would otherwise read Delete
 * as "remove this server".
 */
function RenameField({
    name,
    placeholder,
    onDone
}: {
    name: string;
    placeholder?: string;
    /** The value to save, or null to leave the name as it was. */
    onDone: (value: string | null) => void;
}) {
    const [value, setValue] = useState(name);
    // Deferred rather than `autoFocus`: opened from the context menu, the menu is
    // still holding focus when this mounts and would take it straight back.
    const field = useDeferredFocus<HTMLInputElement>(true);
    const finished = useRef(false);
    const finish = (result: string | null): void => {
        if (finished.current) return;
        finished.current = true;
        onDone(result);
    };
    return (
        <Input
            ref={field}
            value={value}
            placeholder={placeholder}
            aria-label="Server name"
            maxLength={120}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-8"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setValue(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                    event.preventDefault();
                    finish(value);
                } else if (event.key === "Escape") {
                    event.preventDefault();
                    finish(null);
                }
            }}
            onBlur={() => finish(value)}
        />
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
    return (
        <Badge variant="success">
            {status.latencyMs === null ? "Up" : `${status.latencyMs} ms`}
        </Badge>
    );
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
            {server.confirmed ? null : (
                <span className="text-xs text-muted-foreground">detected</span>
            )}
        </button>
    );
}
