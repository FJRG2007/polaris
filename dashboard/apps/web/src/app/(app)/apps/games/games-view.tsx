"use client";

/**
 * The manager: every server this owner runs, what each is doing, and the way to
 * make another.
 *
 * A table rather than cards, and the same table the containers page uses, because
 * that is what these are - a handful of long-lived processes an operator scans
 * down looking for the one that is wrong.
 *
 * The table fills in two passes, because its columns cost wildly different
 * things. Where a server runs and where a player connects are Polaris' own
 * records - a few queries - while who is playing is a round trip into every
 * running container, seconds when one of them is wedged. Asking for both at once
 * meant the whole table waited on the slowest server on the page, so they are two
 * reads: the machine and the address land immediately, and only the player counts
 * hold a skeleton.
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
import type { GameServerFacts, GameServerLive } from "@/lib/apps/games-service";
import { GAMES, type GameDefinition, type GameId } from "@/lib/apps/games-catalog";
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
    cn,
    ConfirmDeleteDialog,
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
    /** Which game it plays. Null only for a catalog that has drifted. */
    game: GameId | null;
    /** The service behind it, for the screens that reach past the game. */
    applicationId: string | null;
    status: string;
    /** Whether this viewer may start, stop and redeploy THIS server. Access is per
     *  server now: a table can hold one somebody runs and one they were only
     *  invited to watch. */
    canManage: boolean;
    /** Whether they may delete it. The owner's, and an administrator's. */
    canRemove: boolean;
}

/** What a row is, as its two reads catch up with the seed. */
interface ServerView extends GameServerSeed {
    /** Where it runs and where a player connects. Null until the first read. */
    facts: GameServerFacts | null;
    /** Who is on it. Null until the servers themselves have answered. */
    live: GameServerLive | null;
}

export function GamesView({
    servers,
    installedGames,
    canCreate
}: {
    servers: GameServerSeed[];
    /** The games this Polaris can create a server of. Empty means no game has been
     *  added yet, and the page is an offer to add one. */
    installedGames: readonly GameId[];
    /** Whether this viewer may make a new server. Instance-wide, unlike what they
     *  may do to the ones already in the table - being invited to help run one is
     *  not an offer to start more. */
    canCreate: boolean;
}) {
    const managerInstalled = installedGames.length > 0;
    const router = useRouter();
    const [facts, setFacts] = useState<Map<string, GameServerFacts>>(new Map());
    const [live, setLive] = useState<Map<string, GameServerLive>>(new Map());
    const [creating, setCreating] = useState(false);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    // The server the delete dialog is asking about, and what it refused with.
    const [deleting, setDeleting] = useState<ServerView | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    // Servers already deleted. They leave the table at once - tearing a container
    // down takes a moment, and a row that sits there until the next poll reads as
    // a button that did nothing.
    const [removed, setRemoved] = useState<string[]>([]);

    const loadFacts = useCallback(async () => {
        if (!managerInstalled) return;
        try {
            const response = await fetch("/api/apps/games", { cache: "no-store" });
            if (!response.ok) return;
            const data = (await response.json()) as { servers?: GameServerFacts[] };
            setFacts(new Map((data.servers ?? []).map((row) => [row.id, row])));
        } catch {
            // Transient; the next poll retries.
        }
    }, [managerInstalled]);

    const loadLive = useCallback(async () => {
        if (!managerInstalled) return;
        try {
            const response = await fetch("/api/apps/games/live", { cache: "no-store" });
            if (!response.ok) return;
            const data = (await response.json()) as { servers?: GameServerLive[] };
            setLive(new Map((data.servers ?? []).map((row) => [row.id, row])));
        } catch {
            // Transient; the next poll retries.
        }
    }, [managerInstalled]);

    // Both start together and land when they land: the table is not held back to
    // the speed of the slower one.
    const reload = useCallback(async () => {
        await Promise.all([loadFacts(), loadLive()]);
    }, [loadFacts, loadLive]);

    useEffect(() => {
        void loadFacts();
        void loadLive();
        const timer = setInterval(() => {
            void loadFacts();
            void loadLive();
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [loadFacts, loadLive]);

    const rows = useMemo<ServerView[]>(
        () =>
            servers
                .filter((server) => !removed.includes(server.id))
                .map((server) => ({
                    ...server,
                    facts: facts.get(server.id) ?? null,
                    live: live.get(server.id) ?? null
                })),
        [servers, facts, live, removed]
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
            await reload();
            router.refresh();
        });
    }

    function onConfirmDelete(): void {
        const server = deleting;
        if (!server) return;
        setDeleteError(null);
        startTransition(async () => {
            const result = await deleteGameServerAction(server.id);
            if (result.error) {
                setDeleteError(result.error);
                return;
            }
            setRemoved((ids) => [...ids, server.id]);
            setDeleting(null);
            await reload();
            router.refresh();
        });
    }

    const missing = GAMES.filter((game) => !installedGames.includes(game.id));

    if (!managerInstalled) return <AddGames games={GAMES} canAdd={canCreate} />;

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Game servers"
                description={
                    servers.length === 0
                        ? "Run game servers on your own machines."
                        : `${servers.length} ${servers.length === 1 ? "server" : "servers"}, ${playing} playing right now.`
                }
                actions={
                    canCreate ? (
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
                            Pick the game, say who plays on it, and Polaris sizes it, closes it to everyone else and
                            gives it an address.
                        </p>
                        {canCreate && (
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
                                    canManage={server.canManage}
                                    canRemove={server.canRemove}
                                    pending={pending}
                                    onRun={run}
                                    onDelete={() => {
                                        setDeleteError(null);
                                        setDeleting(server);
                                    }}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* A game somebody has not added yet is one they cannot create a server
                of, and the create dialog only offers what is on. Saying so here is
                cheaper than a trip to the marketplace to find out what is missing. */}
            {canCreate && missing.length > 0 && <AddGames games={missing} canAdd compact />}

            {creating && <NewServerDialog onClose={() => setCreating(false)} />}
            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && !pending && setDeleting(null)}
                name={deleting?.name ?? ""}
                kind="server"
                description="The server is stopped and its container removed. The world and everything else on a server-local volume goes with it; data on a NAS mount is kept."
                error={deleteError}
                pending={pending}
                onConfirm={onConfirmDelete}
            />
        </div>
    );
}

/**
 * The games that can be added, and the button that adds one.
 *
 * A game is an app: it is installed, and until one is there is nothing on this
 * page to manage. Adding it runs nothing - it is what makes this Polaris able to
 * create servers of that game - so the card says what a server of it will actually
 * cost, which is the one thing that differs by an order of magnitude between them
 * and the one thing nobody finds out until the disk is full.
 *
 * `compact` is the same list under a table that already has servers in it, for
 * adding the second game.
 */
function AddGames({
    games,
    canAdd,
    compact = false
}: {
    games: readonly GameDefinition[];
    canAdd: boolean;
    compact?: boolean;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [adding, setAdding] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    function add(gameId: string): void {
        setError(null);
        setAdding(gameId);
        startTransition(async () => {
            const result = await installManagerAction(gameId);
            setAdding(null);
            if (result.error) {
                setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    const list = (
        <div className="flex flex-col gap-2">
            {games.map((game) => (
                <div
                    key={game.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left"
                >
                    <div className="flex min-w-0 items-start gap-2">
                        <Gamepad2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                            <p className="text-sm font-medium">{game.name}</p>
                            <p className="text-xs text-muted-foreground">{game.summary}</p>
                            <p className="text-xs text-muted-foreground/80">{game.demands}</p>
                        </div>
                    </div>
                    {canAdd && (
                        <Button size="sm" onClick={() => add(game.id)} disabled={pending}>
                            {pending && adding === game.id && <Loader2 className="size-4 animate-spin" />}
                            Add
                        </Button>
                    )}
                </div>
            ))}
        </div>
    );

    if (compact) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-3">
                    <p className="text-sm font-medium">Add another game</p>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    {list}
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-6">
            <PageHeader title="Game servers" description="Run game servers on your own machines." />
            <Card>
                <CardBody className="flex flex-col gap-3 py-8">
                    <p className="text-sm font-medium">Add a game</p>
                    <p className="max-w-xl text-sm text-muted-foreground">
                        Adding one turns this page on for it: create as many servers as you want, each with its own
                        address, console, players and settings. Nothing runs until you create a server.
                    </p>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    {list}
                    <p className="text-xs text-muted-foreground">
                        Creating a Minecraft server accepts the{" "}
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
 *  browsed from. Null for a server that has no container to browse. Each game
 *  keeps them somewhere else, and landing on an empty directory reads as a server
 *  with nothing in it. */
function filesHref(applicationId: string | null, game: GameId | null): string | null {
    return applicationId ? `/drive?c=container:${applicationId}&p=${game === "ark" ? "/app" : "/data"}` : null;
}

function ServerRow({
    server,
    canManage,
    canRemove,
    pending,
    onRun,
    onDelete
}: {
    server: ServerView;
    canManage: boolean;
    canRemove: boolean;
    pending: boolean;
    onRun: (action: () => Promise<{ error?: string }>) => void;
    onDelete: () => void;
}) {
    const { facts, live } = server;
    const href = `/apps/installed/${server.id}`;
    const files = filesHref(server.applicationId, server.game);
    const running = facts?.running ?? false;
    const address = facts?.address ?? null;
    // Start and stop act on what the server is meant to be doing, which is the
    // first read - so they are offered as soon as it lands rather than waiting on
    // the containers to be asked who is playing.
    const known = facts !== null;

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
                        <StatusBadge facts={facts} live={live} status={server.status} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                        <PlayersCell facts={facts} live={live} />
                    </td>
                    <td className="px-3 py-2">
                        <AddressCell name={server.name} facts={facts} />
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                        {facts === null ? <Skeleton className="h-4 w-24" /> : (facts.serverName ?? "-")}
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
                                </>
                            )}
                            {canRemove && (
                                <IconButton label={`Delete ${server.name}`} disabled={pending} onClick={onDelete}>
                                    <Trash2 className="size-4" />
                                </IconButton>
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
                    </>
                )}
                {canRemove && (
                    <>
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

/** Who is on, and the names behind the count for a server small enough to say. A
 *  server that is not meant to be up has nobody on it, which is known without
 *  asking it. */
function PlayersCell({ facts, live }: { facts: GameServerFacts | null; live: GameServerLive | null }) {
    // A server nobody can be on still has a size, and it is worth saying: "0 / 20"
    // is the same shape as every other row, where a dash reads as "not known" and
    // makes the column impossible to scan down.
    const answering = live?.answering ?? false;
    if (!answering && facts === null) return <Skeleton className="h-4 w-12" />;
    const online = answering ? live?.online ?? 0 : 0;
    const total = (answering ? live?.max : null) || facts?.slots;
    if (!total) return <span>-</span>;
    return (
        <span
            className={cn("flex items-center gap-1", !answering && "text-muted-foreground/60")}
            title={
                !answering
                    ? "Nobody can be on: the server is not answering"
                    : live && live.players.length > 0
                      ? live.players.join(", ")
                      : "Nobody is playing right now"
            }
        >
            <Users className="size-3.5" />
            {online} / {total}
        </span>
    );
}

/** Where a player connects. The name when it has one, the machine's address when
 *  it does not, and why there is neither when there is neither. */
function AddressCell({ name, facts }: { name: string; facts: GameServerFacts | null }) {
    if (facts === null) return <Skeleton className="h-4 w-40" />;
    if (!facts.address) {
        return <span className="text-xs text-muted-foreground">{facts.message ?? "No address yet"}</span>;
    }
    return (
        <div className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono text-xs" title={facts.address}>
                {facts.address}
            </code>
            <CopyButton value={facts.address} label={`the address of ${name}`} />
        </div>
    );
}

function StatusBadge({
    facts,
    live,
    status
}: {
    facts: GameServerFacts | null;
    live: GameServerLive | null;
    status: string;
}) {
    // An install that failed stays failed however the container reads: a create
    // that fell over leaves nothing running, and reporting that as merely
    // "Stopped" invites somebody to press Start on a server that was never built.
    if (status === "failed" && !facts?.running) return <Badge variant="danger">Failed</Badge>;
    if (facts === null) return <Badge>Loading</Badge>;
    if (!facts.running) return <Badge>Stopped</Badge>;
    // Meant to be up and is not: stopped from outside Polaris, or fallen over.
    if (live?.containerRunning === false) return <Badge variant="danger">Not running</Badge>;
    // Up, but whether it is actually answering is the read that is still out -
    // saying "Online" before the server has said so would be reporting the
    // container, which is the thing an operator opens this page to distrust.
    if (live === null) return <Badge variant="warning">Checking</Badge>;
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
