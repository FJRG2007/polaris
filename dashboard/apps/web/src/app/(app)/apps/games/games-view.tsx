"use client";

/**
 * The manager: every server this owner runs, what each is doing, and the way to
 * make another.
 *
 * A table rather than cards, and the same table the containers page uses, because
 * that is what these are - a handful of long-lived processes an operator scans
 * down looking for the one that is wrong. The rows paint from what the page
 * already knows and the live parts - who is playing, whether it is answering,
 * where to connect - arrive from the page's own API, so opening it never waits on
 * a container.
 *
 * Every verb is on the row: the icons for the two or three anybody uses, and a
 * right-click for the rest. Deleting is deliberately among them - a server whose
 * create failed has a page with nothing to render, and until now the only way to
 * be rid of one was the page that would not open.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { NewServerDialog } from "./new-server-dialog";
import { useConfirm } from "@/components/confirm-dialog";
import type { GameServerRow } from "@/lib/apps/games-service";
import { useCallback, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import {
    deleteGameServerAction,
    installManagerAction,
    redeployGameServerAction,
    setGameServerRunningAction
} from "./actions";
import {
    Copy,
    ExternalLink,
    FolderOpen,
    Gamepad2,
    Loader2,
    Play,
    Plus,
    RefreshCw,
    Square,
    Trash2,
    Users
} from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger,
    PageHeader,
    Skeleton
} from "@polaris/ui";

const POLL_MS = 6000;

/** What the page knows before anything is polled. */
export interface GameServerSeed {
    id: string;
    name: string;
    catalogId: string;
    catalogName: string;
    edition: "java" | "bedrock";
    /** The service behind it, for the screens that reach past the game. */
    applicationId: string | null;
    status: string;
}

/** What a row is, once the live read has caught up with the seed. */
interface ServerView extends GameServerSeed {
    live: GameServerRow | null;
}

export function GamesView({
    servers,
    managerInstalled,
    canManage
}: {
    servers: GameServerSeed[];
    managerInstalled: boolean;
    /** Whether this viewer may start, stop or delete. A reader still sees
     *  everything the table reports. */
    canManage: boolean;
}) {
    const router = useRouter();
    const [live, setLive] = useState<Map<string, GameServerRow>>(new Map());
    const [creating, setCreating] = useState(false);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();
    // Servers whose deletion is in flight. They leave the table at once - tearing
    // a container down takes a moment, and a row that sits there until the next
    // poll reads as a button that did nothing. A refusal puts the row back.
    const [deleting, setDeleting] = useState<string[]>([]);

    const load = useCallback(async () => {
        if (!managerInstalled) return;
        try {
            const response = await fetch("/api/apps/games", { cache: "no-store" });
            if (!response.ok) return;
            const data = (await response.json()) as { servers?: GameServerRow[] };
            setLive(new Map((data.servers ?? []).map((row) => [row.id, row])));
        } catch {
            // Transient; the next poll retries.
        }
    }, [managerInstalled]);

    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [load]);

    const rows = useMemo<ServerView[]>(
        () =>
            servers
                .filter((server) => !deleting.includes(server.id))
                .map((server) => ({ ...server, live: live.get(server.id) ?? null })),
        [servers, live, deleting]
    );
    const playing = useMemo(() => rows.reduce((total, row) => total + (row.live?.online ?? 0), 0), [rows]);

    function run(action: () => Promise<{ error?: string }>): void {
        setError(null);
        startTransition(async () => {
            const result = await action();
            if (result.error) {
                setError(result.error);
                return;
            }
            await load();
            router.refresh();
        });
    }

    async function onDelete(server: ServerView): Promise<void> {
        const confirmed = await confirm({
            title: `Delete ${server.name}?`,
            description:
                "The server is stopped and its container removed. The world and everything else on a server-local volume goes with it; data on a NAS mount is kept.",
            confirmLabel: "Delete",
            danger: true
        });
        if (!confirmed) return;
        setError(null);
        setDeleting((ids) => [...ids, server.id]);
        startTransition(async () => {
            const result = await deleteGameServerAction(server.id);
            if (result.error) {
                setDeleting((ids) => ids.filter((id) => id !== server.id));
                setError(result.error);
                return;
            }
            await load();
            router.refresh();
        });
    }

    if (!managerInstalled) return <InstallManager />;

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Game servers"
                description={
                    servers.length === 0
                        ? "Run Minecraft servers on your own machines."
                        : `${servers.length} ${servers.length === 1 ? "server" : "servers"}, ${playing} playing right now.`
                }
                actions={
                    canManage ? (
                        <Button onClick={() => setCreating(true)}>
                            <Plus className="size-4" /> New server
                        </Button>
                    ) : null
                }
            />

            {error && <p className="text-sm text-danger">{error}</p>}

            {servers.length === 0 ? (
                <Card>
                    <CardBody className="flex flex-col items-center gap-3 py-12 text-center">
                        <Gamepad2 className="size-8 text-muted-foreground" />
                        <p className="text-sm font-medium">No servers yet</p>
                        <p className="max-w-md text-sm text-muted-foreground">
                            Pick who it is for and what it plays, and Polaris sizes it, protects it and gives it an
                            address. Java is the PC edition, Bedrock is phones and consoles, and one server can take
                            both.
                        </p>
                        {canManage && (
                            <Button onClick={() => setCreating(true)}>
                                <Plus className="size-4" /> New server
                            </Button>
                        )}
                    </CardBody>
                </Card>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full min-w-[52rem] text-sm">
                        <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-3 py-2 font-medium">Server</th>
                                <th className="px-3 py-2 font-medium">Status</th>
                                <th className="px-3 py-2 font-medium">Players</th>
                                <th className="px-3 py-2 font-medium">Address</th>
                                <th className="hidden px-3 py-2 font-medium lg:table-cell">Machine</th>
                                <th className="px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((server) => (
                                <ServerRow
                                    key={server.id}
                                    server={server}
                                    canManage={canManage}
                                    pending={pending}
                                    onRun={run}
                                    onDelete={() => void onDelete(server)}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {creating && <NewServerDialog onClose={() => setCreating(false)} />}
            {confirmDialog}
        </div>
    );
}

/** The manager is an app: it is installed, and until it is there is nothing here
 *  to manage. One button rather than a trip to the marketplace to find it. */
function InstallManager() {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    return (
        <div className="flex flex-col gap-6">
            <PageHeader title="Game servers" description="Run Minecraft servers on your own machines." />
            <Card>
                <CardBody className="flex flex-col items-center gap-3 py-12 text-center">
                    <Gamepad2 className="size-8 text-muted-foreground" />
                    <p className="text-sm font-medium">Install the Minecraft manager</p>
                    <p className="max-w-md text-sm text-muted-foreground">
                        It adds this page for real: create as many servers as you want, Java or Bedrock, each with its
                        own address, console, players and mods. Nothing runs until you create a server.
                    </p>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <Button
                        onClick={() =>
                            startTransition(async () => {
                                const result = await installManagerAction();
                                if (result.error) {
                                    setError(result.error);
                                    return;
                                }
                                router.refresh();
                            })
                        }
                        disabled={pending}
                    >
                        {pending && <Loader2 className="size-4 animate-spin" />}
                        Install
                    </Button>
                    <p className="text-xs text-muted-foreground">
                        Creating a server accepts the{" "}
                        <a
                            href="https://www.minecraft.net/eula"
                            target="_blank"
                            rel="noreferrer"
                            className="underline underline-offset-2 hover:text-foreground"
                        >
                            Minecraft EULA
                        </a>
                        .
                    </p>
                </CardBody>
            </Card>
        </div>
    );
}

/** The world's files, in the same explorer every other file in Polaris is
 *  browsed from. Null for a server that has no container to browse. */
function filesHref(applicationId: string | null): string | null {
    return applicationId ? `/drive?c=container:${applicationId}&p=/data` : null;
}

function ServerRow({
    server,
    canManage,
    pending,
    onRun,
    onDelete
}: {
    server: ServerView;
    canManage: boolean;
    pending: boolean;
    onRun: (action: () => Promise<{ error?: string }>) => void;
    onDelete: () => void;
}) {
    const live = server.live;
    const href = `/apps/installed/${server.id}`;
    const files = filesHref(server.applicationId);
    const running = live?.running ?? false;
    const address = live?.address ?? null;
    // Until the first poll answers there is nothing to say about the container, so
    // the lifecycle verbs wait rather than offer the wrong one.
    const known = live !== null;

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <tr className="border-t border-border hover:bg-card-hover">
                    <td className="px-3 py-2">
                        <Link
                            href={href}
                            className="block max-w-full truncate font-medium hover:underline"
                            title={server.name}
                        >
                            {server.name}
                        </Link>
                        {/* Not the machine: that has a column of its own. */}
                        <span className="block truncate text-xs text-muted-foreground" title={server.catalogName}>{server.catalogName}</span>
                    </td>
                    <td className="px-3 py-2">
                        <StatusBadge live={live} status={server.status} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                        <PlayersCell live={live} />
                    </td>
                    <td className="px-3 py-2">
                        <AddressCell name={server.name} live={live} />
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                        {live === null ? <Skeleton className="h-4 w-24" /> : (live.serverName ?? "-")}
                    </td>
                    <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                            <IconLink label={`Open ${server.name}`} href={href}>
                                <ExternalLink className="size-4" />
                            </IconLink>
                            {files && (
                                <IconLink label={`Browse the files of ${server.name}`} href={files}>
                                    <FolderOpen className="size-4" />
                                </IconLink>
                            )}
                            {canManage && (
                                <>
                                    <IconButton
                                        label={running ? `Stop ${server.name}` : `Start ${server.name}`}
                                        disabled={pending || !known || !server.applicationId}
                                        onClick={() => onRun(() => setGameServerRunningAction(server.id, !running))}
                                    >
                                        {running ? <Square className="size-4" /> : <Play className="size-4" />}
                                    </IconButton>
                                    <IconButton label={`Delete ${server.name}`} disabled={pending} onClick={onDelete}>
                                        <Trash2 className="size-4" />
                                    </IconButton>
                                </>
                            )}
                        </div>
                    </td>
                </tr>
            </ContextMenuTrigger>

            <ContextMenuContent>
                <ContextMenuLabel>{server.name}</ContextMenuLabel>
                <ContextMenuSeparator />
                <ContextMenuItem asChild>
                    <Link href={href}>
                        <ExternalLink className="size-4" /> Open
                    </Link>
                </ContextMenuItem>
                {files && (
                    <ContextMenuItem asChild>
                        <Link href={files}>
                            <FolderOpen className="size-4" /> Files
                        </Link>
                    </ContextMenuItem>
                )}
                {address && (
                    <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(address)}>
                        <Copy className="size-4" /> Copy address
                    </ContextMenuItem>
                )}
                {canManage && (
                    <>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                            disabled={pending || !known || !server.applicationId}
                            onSelect={() => onRun(() => setGameServerRunningAction(server.id, !running))}
                        >
                            {running ? <Square className="size-4" /> : <Play className="size-4" />}
                            {running ? "Stop" : "Start"}
                        </ContextMenuItem>
                        <ContextMenuItem
                            disabled={pending || !server.applicationId}
                            onSelect={() => onRun(() => redeployGameServerAction(server.id))}
                        >
                            <RefreshCw className="size-4" /> Redeploy
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="danger" disabled={pending} onSelect={onDelete}>
                            <Trash2 className="size-4" /> Delete
                        </ContextMenuItem>
                    </>
                )}
            </ContextMenuContent>
        </ContextMenu>
    );
}

/** Who is on, and the names behind the count for a server small enough to say. */
function PlayersCell({ live }: { live: GameServerRow | null }) {
    if (live === null) return <Skeleton className="h-4 w-12" />;
    if (!live.answering) return <span>-</span>;
    return (
        <span
            className="flex items-center gap-1"
            title={live.players.length > 0 ? live.players.join(", ") : "Nobody is playing right now"}
        >
            <Users className="size-3.5" />
            {live.online} / {live.max}
        </span>
    );
}

/** Where a player connects. The name when it has one, the machine's address when
 *  it does not, and why there is neither when there is neither. */
function AddressCell({ name, live }: { name: string; live: GameServerRow | null }) {
    if (live === null) return <Skeleton className="h-4 w-40" />;
    if (!live.address) {
        return <span className="text-xs text-muted-foreground">{live.message ?? "No address yet"}</span>;
    }
    return (
        <div className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono text-xs" title={live.address}>
                {live.address}
            </code>
            <CopyButton value={live.address} label={`the address of ${name}`} />
        </div>
    );
}

function StatusBadge({ live, status }: { live: GameServerRow | null; status: string }) {
    // An install that failed stays failed however the container reads: a create
    // that fell over leaves nothing running, and reporting that as merely
    // "Stopped" invites somebody to press Start on a server that was never built.
    if (status === "failed" && !live?.running) return <Badge variant="danger">Failed</Badge>;
    if (live === null) return <Badge>Loading</Badge>;
    if (!live.running) return <Badge>Stopped</Badge>;
    if (!live.answering) return <Badge variant="warning">Starting</Badge>;
    return <Badge variant="success">Online</Badge>;
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
