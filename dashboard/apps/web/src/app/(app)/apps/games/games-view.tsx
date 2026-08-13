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
 *
 * Searching, filtering, sorting and what somebody has starred or put away all live
 * on the client, over rows that are already here. A dozen servers is not a data
 * set, and asking the server to filter would put a round trip - and a spinner -
 * between a keystroke and a table that could have been reordered as it was typed.
 */

import Link from "next/link";
import * as list from "./list";
import { useRouter } from "next/navigation";
import { relativeTime } from "@/lib/relative-time";
import { GameLogo } from "@/components/game-picker";
import { CopyButton } from "@/components/copy-button";
import { NewServerDialog } from "./new-server-dialog";
import { GAMES, type GameId } from "@/lib/apps/games-catalog";
import { useDisplayFormat } from "@/components/display-format";
import { useGamePresence } from "@/components/use-game-presence";
import type { GameServerFacts, GameServerLive } from "@/lib/apps/games-service";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import {
    deleteGameServerAction,
    installGameServersAction,
    redeployGameServerAction,
    setGameServerPrefAction,
    setGameServerRunningAction
} from "./actions";
import {
    Archive,
    ArchiveRestore,
    ArrowDown,
    ArrowUp,
    ArrowUpDown,
    Copy,
    ExternalLink,
    FolderOpen,
    Gamepad2,
    Loader2,
    Play,
    Plus,
    RefreshCw,
    Search,
    Square,
    Star,
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
    Input,
    PageHeader,
    Select,
    Skeleton
} from "@polaris/ui";

/** How often the table re-reads what Polaris knows by itself - a server added,
 *  renamed or deleted somewhere else. Who is playing does not come from here: it
 *  arrives on the live stream, which pushes it as it changes. This is also the
 *  backstop if that stream cannot be held open at all. */
const POLL_MS = 20000;

export function GamesView({
    servers,
    installed,
    canCreate
}: {
    servers: list.GameServerSeed[];
    /** Whether the Game servers app is on for this owner. False means the page is
     *  an offer to turn it on rather than a list of nothing. */
    installed: boolean;
    /** Whether this viewer may make a new server. Instance-wide, unlike what they
     *  may do to the ones already in the table - being invited to help run one is
     *  not an offer to start more. */
    canCreate: boolean;
}) {
    const managerInstalled = installed;
    const router = useRouter();
    const [facts, setFacts] = useState<Map<string, GameServerFacts>>(new Map());
    const [live, setLive] = useState<Map<string, GameServerLive>>(new Map());
    // Who is on each server, pushed as it changes rather than polled for. Shared
    // with every other tab on this device, and with the panels of the servers
    // themselves, so all of them agree at the same moment.
    const presence = useGamePresence();
    const [creating, setCreating] = useState(false);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    // The server the delete dialog is asking about, and what it refused with.
    const [deleting, setDeleting] = useState<list.ServerView | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    // Servers already deleted. They leave the table at once - tearing a container
    // down takes a moment, and a row that sits there until the next poll reads as
    // a button that did nothing.
    const [removed, setRemoved] = useState<string[]>([]);
    // Stars and archivings this tab has just made, laid over what the page was
    // rendered with. Starring is a click on a row's own icon and has to land on
    // the row, not a page later.
    const [prefs, setPrefs] = useState<Map<string, { favorite: boolean; archived: boolean }>>(new Map());

    const [query, setQuery] = useState("");
    const [gameFilter, setGameFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [showArchived, setShowArchived] = useState(false);
    const [sortKey, setSortKey] = useState<list.SortKey>(null);
    const [sortDir, setSortDir] = useState<list.SortDir>("asc");

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

    // Whether the stream is feeding this screen, read inside the interval below
    // without making it restart every time a frame arrives.
    const streaming = useRef(false);
    streaming.current = presence.at > 0;

    useEffect(() => {
        void loadFacts();
        void loadLive();
        const timer = setInterval(() => {
            void loadFacts();
            // Who is playing comes off the stream once it is connected, and asking
            // for it again would be a command inside every container for an answer
            // already on screen. This is what keeps the table live for a browser
            // that cannot hold a stream open at all.
            if (!streaming.current) void loadLive();
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [loadFacts, loadLive]);

    // A frame is newer than anything the backstop poll fetched, so it wins.
    useEffect(() => {
        if (presence.at === 0) return;
        setLive(
            new Map(
                [...presence.servers].map(([id, server]) => [
                    id,
                    // The row prints names; the ids beside them are for the screens
                    // that offer a verb against one person.
                    { ...server, players: server.players.map((player) => player.name) }
                ])
            )
        );
    }, [presence]);

    const rows = useMemo<list.ServerView[]>(
        () =>
            servers
                .filter((server) => !removed.includes(server.id))
                .map((server) => ({
                    ...server,
                    ...(prefs.get(server.id) ?? {}),
                    facts: facts.get(server.id) ?? null,
                    live: live.get(server.id) ?? null
                })),
        [servers, facts, live, removed, prefs]
    );
    const playing = useMemo(() => rows.reduce((total, row) => total + (row.live?.online ?? 0), 0), [rows]);
    const archivedCount = useMemo(() => rows.filter((row) => row.archived).length, [rows]);
    const shelf = useMemo(() => rows.filter((row) => row.archived === showArchived), [rows, showArchived]);
    const visible = useMemo(
        () => list.sortServers(list.filterServers(shelf, query, gameFilter, statusFilter), sortKey, sortDir),
        [shelf, query, gameFilter, statusFilter, sortKey, sortDir]
    );
    const filtering = query.trim().length > 0 || gameFilter !== "" || statusFilter !== "";

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

    /** Star a server or put it away, on the row, now. The write follows; if it is
     *  refused the row goes back to what it was and says why. */
    function setPref(server: list.ServerView, patch: { favorite?: boolean; archived?: boolean }): void {
        const before = { favorite: server.favorite, archived: server.archived };
        setPrefs((held) => new Map(held).set(server.id, { ...before, ...patch }));
        setError(null);
        startTransition(async () => {
            const result = await setGameServerPrefAction(server.id, patch);
            if (result.error) {
                setPrefs((held) => new Map(held).set(server.id, before));
                setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    /** Click a sortable column: its own end first, then the other, then back to
     *  the order the page was built in. */
    function toggleSort(key: Exclude<list.SortKey, null>): void {
        const next = list.nextSort({ key: sortKey, dir: sortDir }, key);
        setSortKey(next.key);
        setSortDir(next.dir);
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

    if (!managerInstalled) return <TurnOnGameServers canAdd={canCreate} />;

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Game servers"
                description={
                    rows.length === 0
                        ? "Run game servers on your own machines."
                        : `${rows.length} ${rows.length === 1 ? "server" : "servers"}, ${playing} playing right now.`
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

            {rows.length === 0 ? (
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
                <>
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="relative min-w-48 flex-1">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="Search servers, addresses, machines or versions"
                                className="pl-8"
                                aria-label="Search servers"
                            />
                        </div>
                        <Select
                            value={gameFilter}
                            onValueChange={setGameFilter}
                            aria-label="Filter by game"
                            className="w-40"
                            options={[
                                { value: "", label: "Every game" },
                                ...GAMES.map((game) => ({ value: game.id, label: game.name }))
                            ]}
                        />
                        <Select
                            value={statusFilter}
                            onValueChange={setStatusFilter}
                            aria-label="Filter by status"
                            className="w-40"
                            options={[
                                { value: "", label: "Any status" },
                                { value: "online", label: "Online" },
                                { value: "starting", label: "Starting" },
                                { value: "stopped", label: "Stopped" },
                                { value: "problem", label: "Needs attention" }
                            ]}
                        />
                        {(archivedCount > 0 || showArchived) && (
                            <Button
                                variant={showArchived ? "secondary" : "ghost"}
                                onClick={() => setShowArchived((shown) => !shown)}
                                title={showArchived ? "Back to the servers you use" : "The servers you put away"}
                            >
                                <Archive className="size-4" />
                                Archived {archivedCount > 0 ? `(${archivedCount})` : ""}
                            </Button>
                        )}
                    </div>

                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full min-w-[52rem] text-sm">
                            <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="px-3 py-2 font-medium">Server</th>
                                    <SortHeader
                                        label="Status"
                                        sorted={sortKey === "status" ? sortDir : null}
                                        onClick={() => toggleSort("status")}
                                    />
                                    <SortHeader
                                        label="Players"
                                        sorted={sortKey === "players" ? sortDir : null}
                                        onClick={() => toggleSort("players")}
                                    />
                                    <th className="hidden px-3 py-2 font-medium md:table-cell">Version</th>
                                    <th className="px-3 py-2 font-medium">Address</th>
                                    <th className="hidden px-3 py-2 font-medium lg:table-cell">Machine</th>
                                    <th className="px-3 py-2" />
                                </tr>
                            </thead>
                            <tbody>
                                {visible.map((server) => (
                                    <ServerRow
                                        key={server.id}
                                        server={server}
                                        canManage={server.canManage}
                                        canRemove={server.canRemove}
                                        pending={pending}
                                        onRun={run}
                                        onPref={(patch) => setPref(server, patch)}
                                        onDelete={() => {
                                            setDeleteError(null);
                                            setDeleting(server);
                                        }}
                                    />
                                ))}
                                {visible.length === 0 && (
                                    <tr>
                                        <td colSpan={7} className="px-3 py-10 text-center text-sm text-muted-foreground">
                                            {filtering ? (
                                                <span className="flex flex-col items-center gap-2">
                                                    No server matches what you asked for.
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() => {
                                                            setQuery("");
                                                            setGameFilter("");
                                                            setStatusFilter("");
                                                        }}
                                                    >
                                                        Clear the filters
                                                    </Button>
                                                </span>
                                            ) : showArchived ? (
                                                "Nothing is archived."
                                            ) : (
                                                "Every server is archived."
                                            )}
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

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

/** A column that can be sorted by, with the arrows that say whether it is and
 *  which way. */
function SortHeader({
    label,
    sorted,
    onClick
}: {
    label: string;
    /** The direction it is sorted in, or null when the table is sorted by
     *  something else. */
    sorted: list.SortDir | null;
    onClick: () => void;
}) {
    return (
        <th className="px-3 py-2 font-medium">
            <button
                type="button"
                onClick={onClick}
                className="flex items-center gap-1 transition-colors hover:text-foreground"
                title={`Sort by ${label.toLowerCase()}`}
            >
                {label}
                {sorted === null ? (
                    <ArrowUpDown className="size-3 opacity-50" />
                ) : sorted === "asc" ? (
                    <ArrowUp className="size-3" />
                ) : (
                    <ArrowDown className="size-3" />
                )}
            </button>
        </th>
    );
}

/**
 * The page before anybody has turned game servers on.
 *
 * One app for every game rather than one per game: turning it on runs nothing,
 * and each game's own runtime arrives with the first server of it - which is why
 * what a server actually costs is said per game here rather than as one number.
 * The difference between them is an order of magnitude, and it is the one thing
 * nobody finds out until the disk is full.
 */
function TurnOnGameServers({ canAdd }: { canAdd: boolean }) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    function turnOn(): void {
        setError(null);
        startTransition(async () => {
            const result = await installGameServersAction();
            if (result.error) {
                setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    return (
        <div className="flex flex-col gap-6">
            <PageHeader title="Game servers" description="Run game servers on your own machines." />
            <Card>
                <CardBody className="flex flex-col gap-4 py-8">
                    <div className="flex flex-col gap-1">
                        <p className="text-sm font-medium">Run game servers</p>
                        <p className="max-w-xl text-sm text-muted-foreground">
                            Create as many as you want, of any game below, each with its own address, console,
                            players and settings. Nothing is downloaded until you create a server, and only for the
                            game that server plays.
                        </p>
                    </div>

                    <div className="flex flex-col gap-2">
                        {GAMES.map((game) => (
                            <div
                                key={game.id}
                                className="flex min-w-0 items-start gap-3 rounded-md border border-border px-3 py-2"
                            >
                                <GameLogo game={game} className="mt-0.5 size-8" />
                                <div className="min-w-0">
                                    <p className="text-sm font-medium">{game.name}</p>
                                    <p className="text-xs text-muted-foreground">{game.summary}</p>
                                    <p className="text-xs text-muted-foreground/80">{game.demands}</p>
                                </div>
                            </div>
                        ))}
                    </div>

                    {error && <p className="text-sm text-danger">{error}</p>}

                    {canAdd && (
                        <Button className="w-fit" onClick={turnOn} disabled={pending}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Turn on game servers
                        </Button>
                    )}

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

/** Why the files of a stopped server cannot be browsed. The explorer reads them
 *  from inside the container, so one that is not running has nothing to read - it
 *  used to answer with an empty directory, which reads as a server whose world has
 *  been deleted. */
const FILES_NEED_RUNNING = "Start the server to browse its files";

function ServerRow({
    server,
    canManage,
    canRemove,
    pending,
    onRun,
    onPref,
    onDelete
}: {
    server: list.ServerView;
    canManage: boolean;
    canRemove: boolean;
    pending: boolean;
    onRun: (action: () => Promise<{ error?: string }>) => void;
    onPref: (patch: { favorite?: boolean; archived?: boolean }) => void;
    onDelete: () => void;
}) {
    const { facts, live } = server;
    const definition = GAMES.find((game) => game.id === server.game) ?? null;
    const href = `/apps/installed/${server.id}`;
    const files = filesHref(server.applicationId, server.game);
    const running = facts?.running ?? false;
    const address = facts?.address ?? null;
    // Start and stop act on what the server is meant to be doing, which is the
    // first read - so they are offered as soon as it lands rather than waiting on
    // the containers to be asked who is playing.
    const known = facts !== null;
    const browsable = list.canBrowseFiles(server);

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <tr className="border-t border-border hover:bg-card-hover">
                    <td className="px-3 py-2">
                        {/* The game's own mark beside the name, because a table of
                            servers of several games is scanned for "the ARK one"
                            long before it is read. */}
                        <div className="flex min-w-0 items-center gap-2">
                            {definition && <GameLogo game={definition} className="size-6" />}
                            <div className="min-w-0">
                                <Link
                                    href={href}
                                    className="block max-w-full truncate font-medium hover:underline"
                                    title={server.name}
                                >
                                    {server.name}
                                </Link>
                                {/* Not the machine: that has a column of its own. */}
                                <span
                                    className="block truncate text-xs text-muted-foreground"
                                    title={server.catalogName}
                                >
                                    {server.catalogName}
                                </span>
                            </div>
                        </div>
                    </td>
                    <td className="px-3 py-2">
                        <StatusCell server={server} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                        <PlayersCell facts={facts} live={live} />
                    </td>
                    <td className="hidden px-3 py-2 md:table-cell">
                        <VersionCell facts={facts} />
                    </td>
                    <td className="px-3 py-2">
                        <AddressCell name={server.name} facts={facts} />
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                        {facts === null ? <Skeleton className="h-4 w-24" /> : (facts.serverName ?? "-")}
                    </td>
                    <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                            <IconButton
                                label={
                                    server.favorite
                                        ? `Take ${server.name} off your favourites`
                                        : `Keep ${server.name} at the top`
                                }
                                disabled={pending}
                                onClick={() => onPref({ favorite: !server.favorite })}
                            >
                                <Star className={cn("size-4", server.favorite && "fill-amber-400 text-amber-400")} />
                            </IconButton>
                            <IconLink label={`Open ${server.name}`} href={href}>
                                <ExternalLink className="size-4" />
                            </IconLink>
                            {files && (
                                <IconLink
                                    label={
                                        browsable ? `Browse the files of ${server.name}` : FILES_NEED_RUNNING
                                    }
                                    href={files}
                                    disabled={!browsable}
                                >
                                    <FolderOpen className="size-4" />
                                </IconLink>
                            )}
                            {canManage && (
                                <IconButton
                                    label={running ? `Stop ${server.name}` : `Start ${server.name}`}
                                    disabled={pending || !known || !server.applicationId}
                                    onClick={() => onRun(() => setGameServerRunningAction(server.id, !running))}
                                >
                                    {running ? <Square className="size-4" /> : <Play className="size-4" />}
                                </IconButton>
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
                {files &&
                    (browsable ? (
                        <ContextMenuItem asChild>
                            <Link href={files}>
                                <FolderOpen className="size-4" /> Files
                            </Link>
                        </ContextMenuItem>
                    ) : (
                        // A disabled item takes no pointer events, so it says why
                        // it is disabled rather than holding the reason in a
                        // tooltip nobody can reach.
                        <ContextMenuItem disabled>
                            <FolderOpen className="size-4" /> Files
                            <span className="ml-auto pl-3 text-xs">{FILES_NEED_RUNNING}</span>
                        </ContextMenuItem>
                    ))}
                {address && (
                    <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(address)}>
                        <Copy className="size-4" /> Copy address
                    </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem disabled={pending} onSelect={() => onPref({ favorite: !server.favorite })}>
                    <Star className={cn("size-4", server.favorite && "fill-amber-400 text-amber-400")} />
                    {server.favorite ? "Remove from favourites" : "Add to favourites"}
                </ContextMenuItem>
                <ContextMenuItem disabled={pending} onSelect={() => onPref({ archived: !server.archived })}>
                    {server.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                    {server.archived ? "Put back in the list" : "Archive"}
                </ContextMenuItem>
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
    const online = answering ? (live?.online ?? 0) : 0;
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

/**
 * What the server runs, for the games where it decides who can join.
 *
 * Minecraft, in practice: a client is one release and so is the server, and
 * "which version is that one again" is the question this table was being read to
 * answer. The software beside it (Paper, Fabric) is the other half - it is what
 * decides whether a plugin or a mod fits. Games that update themselves have
 * nothing useful to put here.
 */
function VersionCell({ facts }: { facts: GameServerFacts | null }) {
    if (facts === null) return <Skeleton className="h-4 w-16" />;
    const release = list.releaseLabel(facts);
    if (!release) return <span className="text-xs text-muted-foreground">-</span>;
    return (
        <div className="flex min-w-0 flex-col">
            <span className="truncate text-xs" title={release}>{release}</span>
            {facts.crossplay && (
                <span
                    className="truncate text-xs text-muted-foreground"
                    title="Bedrock clients can join this Java server"
                >
                    Bedrock too
                </span>
            )}
        </div>
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

/**
 * What the server is doing, and since when.
 *
 * The same shape a player's row has, for the same reason: "Stopped" is the same
 * word whether it went down ten minutes ago or in March, and those are not the
 * same server. A server that is up says how long it has been, which is what tells
 * a restart loop from a world that has been fine all week.
 */
function StatusCell({ server }: { server: list.ServerView }) {
    const format = useDisplayFormat();
    const badge = list.STATUS_BADGE[list.statusOf(server)];
    const line = list.uptimeLine(server);

    return (
        <div className="flex flex-col items-start gap-0.5">
            <Badge {...(badge.variant ? { variant: badge.variant } : {})}>{badge.label}</Badge>
            {line && (
                <span className="text-xs text-muted-foreground" title={format.dateTime(line.at)}>
                    {line.prefix} {relativeTime(line.at, format)}
                </span>
            )}
        </div>
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
 *  handler so it can be middle-clicked, opened in a tab, or copied - unless it
 *  leads somewhere that has nothing to show, in which case it is a disabled button
 *  saying why rather than a link to an empty page. */
function IconLink({
    label,
    href,
    disabled,
    children
}: {
    label: string;
    href: string;
    disabled?: boolean;
    children: ReactNode;
}) {
    if (disabled) {
        // The title goes on the wrapper, not the button: a disabled control takes
        // no pointer events, so the reason it is disabled would never be readable
        // on the one thing somebody would hover to ask.
        return (
            <span title={label} className="inline-flex">
                <Button size="icon" variant="ghost" disabled aria-label={label}>
                    {children}
                </Button>
            </span>
        );
    }
    return (
        <Button size="icon" variant="ghost" asChild aria-label={label} title={label}>
            <Link href={href}>{children}</Link>
        </Button>
    );
}
