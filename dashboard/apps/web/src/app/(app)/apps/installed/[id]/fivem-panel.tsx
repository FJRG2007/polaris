"use client";

/**
 * The FiveM server's own dashboard inside Polaris: where to connect, who is
 * playing, who is allowed to, the console, the resources and the settings.
 *
 * Built the same way the ARK and Minecraft ones are - the same tab bar, the same
 * real paths, the same poll that paints from what the page already knows and fills
 * the live parts in - and it reuses those panels' screens wherever the screen was
 * never about a particular game: sharing a server is sharing an install, the
 * address picker writes DNS, the schedule is the schedule.
 *
 * What is genuinely FiveM's is the players screen. The game has no whitelist and no
 * ban list of its own, so both are Polaris' and are handed to a small resource it
 * installs into the server - which means a player can be on the list and the server
 * not know it yet, and the two states are drawn differently. Anything else would
 * have a moderator adding somebody, watching nothing happen, and adding them again.
 *
 * And a person here is an identifier, never a name. Two players can call
 * themselves the same thing and either can change it between one evening and the
 * next, so every verb on this screen is written against what the game handed over.
 */

import Link from "next/link";
import * as actions from "./fivem-actions";
import { FivemRules } from "./fivem-rules";
import { GameConsole } from "./game-console";
import type { Permission } from "@polaris/core";
import type { GameContext } from "./game-context";
import { FivemResources } from "./fivem-resources";
import { MinecraftAccess } from "./minecraft-access";
import { MinecraftDomain } from "./minecraft-domain";
import { CopyButton } from "@/components/copy-button";
import { useConfirm } from "@/components/confirm-dialog";
import { usePathname, useRouter } from "next/navigation";
import { RelativeTime } from "@/components/relative-time";
import type { PlayerSeen } from "@/lib/apps/games-activity";
import { timeoutRemaining } from "@/lib/apps/player-timeout";
import type { ServerPresence } from "@/lib/apps/games-service";
import { useGamePresence } from "@/components/use-game-presence";
import { presenceLine, seenFor } from "@/lib/apps/games-activity";
import { MinecraftSchedule, NO_SCHEDULE } from "./minecraft-schedule";
import type { GameReachAdvice } from "@/lib/apps/minecraft/reach-advice";
import { PlayerTimeoutDialog } from "@/components/player-timeout-dialog";
import type { FivemAccessView, FivemStatus } from "@/lib/apps/fivem/service";
import { PlayerIconAction, PlayersTable } from "@/components/game-players-table";
import { IDENTIFIER_LABEL, isIdentifier, kindOf } from "@/lib/apps/fivem/players";
import { PlayerFormDialog, PlayerFormField } from "@/components/player-form-dialog";
import { isLicenseKey, KEYMASTER_URL, LICENSE_KEY_HINT } from "@/lib/apps/fivem/config";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { canOpenGameTab, gameTabHref, gameTabLabel, isGameTab, visibleGameTabs } from "./tabs";
import { CONSUMPTION_METRICS, MetricsHistory, PLAYER_METRICS } from "@/components/metrics-history";
import { foldFivemPlayers, matchesFivemFilter, matchesFivemPlayer, type FivemPlayerEntry } from "@/lib/apps/fivem/roster";
import {
    generateConsolePassword,
    isBanReason,
    isConsolePassword,
    CONSOLE_PASSWORD_HINT,
    DEFAULT_BAN_REASON,
    REASON_HINT
} from "@/lib/apps/fivem/access";
import {
    playerAction,
    playerConfirm,
    playerFilters,
    playerMenuItem,
    playerPresence,
    playerStanding
} from "@/lib/apps/player-vocabulary";
import {
    AlertTriangle,
    Ban,
    DoorOpen,
    Eye,
    KeyRound,
    Loader2,
    Megaphone,
    MessageSquare,
    MoreHorizontal,
    RefreshCw,
    ShieldMinus,
    ShieldPlus,
    Timer,
    UserMinus,
    UserPlus
} from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    Skeleton,
    Switch,
    cn
} from "@polaris/ui";

/**
 * How long after one read finishes before the next one starts. Measured from the
 * end rather than on a fixed interval: a read runs a command inside the container
 * and a slow one would otherwise have every tick queue behind the last.
 *
 * Unhurried, because who is playing is not read here any more - it arrives on the
 * live stream within a couple of seconds. What this poll is for is what the
 * machine is costing and whether the port answers from outside, both of which
 * move slowly enough that asking every few seconds was only ever noise.
 */
const POLL_MS = 12000;

/** How old a streamed reading may be before the screen stops preferring it to what
 *  the poll last returned. */
const PRESENCE_STALE_MS = 25000;

interface ServerReading {
    status: FivemStatus | null;
    /** What a player types to connect. Worked out from the same read the list
     *  uses, so the two cannot disagree. Null until the first poll answers. */
    address: string | null;
    /** What is still in the way of players outside this network. */
    reach: GameReachAdvice | null;
    access: FivemAccessView | null;
    /** When each of them was last on, by identifier. Polaris' own record: the
     *  game knows who is connected and nothing about a minute ago. */
    seen: Readonly<Record<string, PlayerSeen>>;
}

export function FivemPanel({
    installedAppId,
    applicationId,
    running,
    game,
    held,
    onStatus
}: {
    installedAppId: string;
    applicationId: string | null;
    running: boolean;
    /** The server's address suffix, its name on the domain, the lists Polaris
     *  holds, and the port it was published on. */
    game: GameContext | null;
    held: readonly Permission[];
    onStatus?: (label: string | null) => void;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const tab = useMemo(() => {
        const base = `/apps/installed/${installedAppId}`;
        const slug = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, "") : "";
        return isGameTab(slug, "fivem") && canOpenGameTab(slug, held, "fivem") ? slug : "";
    }, [pathname, installedAppId, held]);
    const tabs = useMemo(() => visibleGameTabs(held, "fivem"), [held]);
    const openTab = useCallback(
        (slug: string) => {
            if (slug === tab) return;
            window.history.pushState(null, "", gameTabHref(installedAppId, slug));
        },
        [installedAppId, tab]
    );

    // Everything the page already knew is on screen before a single request goes
    // out: where to connect, and who is on the list. Only what nobody can answer
    // without asking the server itself waits on the poll.
    const [reading, setReading] = useState<ServerReading>({
        status: null,
        address: game?.address ?? null,
        reach: null,
        access: game?.fivemAccess ?? null,
        seen: {}
    });
    const [error, setError] = useState<string | null>(null);
    /** What Polaris last said it intends the server to do, so the page can re-read
     *  itself when that changes underneath it. */
    const intended = useRef(running);

    const wantsPlayers = tab === "players";

    const load = useCallback(async () => {
        try {
            const query = new URLSearchParams();
            if (wantsPlayers) query.set("players", "1");
            const response = await fetch(
                `/api/apps/installed/${installedAppId}/fivem${query.size > 0 ? `?${query.toString()}` : ""}`,
                { cache: "no-store" }
            );
            const data = (await response.json()) as {
                status?: FivemStatus;
                address?: string | null;
                reach?: GameReachAdvice | null;
                access?: FivemAccessView | null;
                seen?: Record<string, PlayerSeen>;
                error?: string;
            };
            if (!response.ok || !data.status) {
                setError(data.error ?? "Could not read the server");
                return;
            }
            setError(null);
            setReading((current) => ({
                status: data.status ?? null,
                address: data.address ?? current.address,
                // Kept when a poll could not work it out rather than dropped: the
                // warning would flicker on every failed read.
                reach: data.reach ?? current.reach,
                access: data.access ?? current.access,
                seen: data.seen ?? (wantsPlayers ? current.seen : {})
            }));
            // The header's Start and Stop come from the install row. A poll that
            // finds the server in the other state is that row having gone stale.
            if (data.status.running !== intended.current) {
                intended.current = data.status.running;
                router.refresh();
            }
        } catch {
            // Transient; the next poll retries.
        }
    }, [installedAppId, wantsPlayers, router]);

    useEffect(() => {
        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cycle = async (): Promise<void> => {
            await load();
            if (live) timer = setTimeout(() => void cycle(), POLL_MS);
        };
        void cycle();
        return () => {
            live = false;
            if (timer) clearTimeout(timer);
        };
    }, [load]);

    // Who is on it, pushed as it changes rather than waited for. The poll above
    // still reports it, but a poll's worth late; whichever of the two is more
    // recent is what the screen shows.
    const presence = useGamePresence([installedAppId]);
    const streamed = presence.servers.get(installedAppId) ?? null;
    const status = useMemo(
        () =>
            withPresence(
                reading.status,
                streamed && Date.now() - presence.at < PRESENCE_STALE_MS ? streamed : null,
                game?.gamePort ?? null,
                running
            ),
        [reading.status, streamed, presence.at, game?.gamePort, running]
    );
    const isRunning = status?.running ?? running;

    useEffect(() => {
        onStatus?.(statusLabel(status, isRunning));
    }, [onStatus, status, isRunning]);

    return (
        <div className="flex flex-col gap-4">
            <ConnectCard
                status={status}
                address={reading.address}
                port={game?.gamePort ?? null}
                running={isRunning}
                reach={reading.reach}
                access={reading.access}
                onOpenSecurity={() => openTab("security")}
            />

            {error && <p className="text-sm text-danger">{error}</p>}

            <nav className="no-scrollbar flex items-center gap-1 overflow-x-auto border-b border-border/60 text-sm">
                {tabs.map((entry) => (
                    <a
                        key={entry.slug}
                        href={gameTabHref(installedAppId, entry.slug)}
                        aria-current={tab === entry.slug ? "page" : undefined}
                        onClick={(event) => {
                            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                            event.preventDefault();
                            openTab(entry.slug);
                        }}
                        className={cn(
                            "-mb-px whitespace-nowrap border-b-2 px-3 py-2 transition-colors",
                            tab === entry.slug
                                ? "border-primary text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {gameTabLabel(entry, "fivem")}
                    </a>
                ))}
            </nav>

            {tab === "" && <OverviewTab status={status} />}
            {tab === "console" && (
                <GameConsole
                    installedAppId={installedAppId}
                    applicationId={applicationId}
                    running={isRunning}
                    logName="fivem"
                    hint="status, or say Server restarting in 5"
                    game="fivem"
                    players={(status?.players ?? []).map((player) => player.name)}
                />
            )}
            {tab === "players" && (
                <PlayersTab
                    installedAppId={installedAppId}
                    status={status}
                    access={reading.access}
                    seen={reading.seen}
                    canModerate={held.includes("games.moderate")}
                    canManage={held.includes("games.manage")}
                    onChanged={(next) => {
                        if (next) setReading((current) => ({ ...current, access: next }));
                        void load();
                    }}
                />
            )}
            {tab === "mods" && (
                <FivemResources
                    installedAppId={installedAppId}
                    applicationId={applicationId}
                    canManage={held.includes("games.manage")}
                    running={isRunning}
                />
            )}
            {tab === "rules" && (
                <FivemRules
                    installedAppId={installedAppId}
                    canManage={held.includes("games.manage")}
                    running={isRunning}
                />
            )}
            {tab === "usage" &&
                (applicationId ? (
                    <div className="space-y-4">
                        {/* The one an operator opens this tab for: what the box cost
                            only means something beside how many it carried. */}
                        <MetricsHistory
                            endpoint={`/api/apps/installed/${installedAppId}/game/players`}
                            metrics={PLAYER_METRICS}
                        />
                        <MetricsHistory
                            endpoint={`/api/deploy/apps/${applicationId}/metrics/history`}
                            metrics={CONSUMPTION_METRICS}
                        />
                    </div>
                ) : (
                    <Card>
                        <CardBody className="py-10 text-center text-sm text-muted-foreground">
                            Usage is measured once the server has deployed.
                        </CardBody>
                    </Card>
                ))}
            {tab === "security" && (
                <div className="flex flex-col gap-4">
                    <ClosedServerCard
                        installedAppId={installedAppId}
                        access={reading.access}
                        guardRunning={status?.guardRunning ?? null}
                        canManage={held.includes("games.manage")}
                        onChanged={(next) => {
                            if (next) setReading((current) => ({ ...current, access: next }));
                            void load();
                        }}
                        onOpenPlayers={() => openTab("players")}
                    />
                    <ConsolePasswordCard
                        installedAppId={installedAppId}
                        canManage={held.includes("games.manage")}
                        running={isRunning}
                    />
                </div>
            )}
            {tab === "access" && <MinecraftAccess installedAppId={installedAppId} />}
            {tab === "settings" && (
                <div className="flex flex-col gap-4">
                    <MinecraftSchedule
                        runs={game?.routineRuns ?? null}
                        installedAppId={installedAppId}
                        schedule={game?.schedule ?? NO_SCHEDULE}
                        state={game?.scheduleState ?? null}
                    />
                    <MinecraftDomain
                        installedAppId={installedAppId}
                        hostname={game?.hostname ?? null}
                        suffix={game?.suffix ?? null}
                        address={reading.address}
                    />
                    <ServerKeyCard installedAppId={installedAppId} canManage={held.includes("games.manage")} />
                </div>
            )}
        </div>
    );
}

/** The streamed reading laid over the polled one, so who is playing is never a
 *  poll behind what the stream already said. */
function withPresence(
    status: FivemStatus | null,
    presence: ServerPresence | null,
    port: number | null,
    running: boolean
): FivemStatus | null {
    if (!presence) return status;
    // The stream carries a name and the identifier a rule can be written against,
    // which is what the row needs; the ping and the rest arrive on the poll.
    const players = presence.players.map((player) => ({
        id: -1,
        name: player.name,
        ping: 0,
        identifiers: player.id ? [player.id] : [],
        endpoint: null
    }));
    const live = {
        answering: presence.answering,
        containerRunning: presence.containerRunning,
        players,
        max: presence.max,
        message: presence.message,
        crashLoop: presence.crashLoop
    };
    if (status) {
        // The poll's own player rows are richer - they carry the slot number every
        // console command takes - so they win whenever the two agree on the count.
        return presence.players.length === status.players.length && status.answering
            ? { ...status, answering: presence.answering, containerRunning: presence.containerRunning }
            : { ...status, ...live };
    }
    return {
        ...live,
        running,
        port,
        hostname: null,
        build: null,
        resourcesRunning: null,
        guardRunning: null,
        cpuPercent: null,
        memUsedBytes: null,
        memTotalBytes: null
    };
}

function statusLabel(status: FivemStatus | null, running: boolean): string | null {
    if (status === null) return null;
    // Before either of the two words below, both of which a looping container is
    // momentarily entitled to and neither of which is the useful one.
    if (status.crashLoop) return "Crash loop";
    if (!running || !status.running) return "Stopped";
    if (status.containerRunning === false) return "Not running";
    return status.answering ? "Online" : "Starting";
}

function StatusBadge({ status, running }: { status: FivemStatus | null; running: boolean }) {
    const label = statusLabel(status, running);
    if (label === null) return <Skeleton className="h-6 w-20" />;
    if (label === "Crash loop") return <Badge variant="danger">Crash loop</Badge>;
    if (label === "Not running") return <Badge variant="danger">Not running</Badge>;
    if (label === "Starting") return <Badge className="border-warning/40 text-warning">Starting</Badge>;
    if (label === "Stopped") return <Badge>Stopped</Badge>;
    return <Badge className="border-success/40 text-success">Online</Badge>;
}

/** The address with the port on it, which is what a FiveM player actually types -
 *  the game carries no way of looking the port up. */
function withPort(address: string, port: number | null): string {
    if (port === null) return address;
    return address.includes(":") ? address : `${address}:${port}`;
}

function ConnectCard({
    status,
    address,
    port,
    running,
    reach,
    access,
    onOpenSecurity
}: {
    status: FivemStatus | null;
    address: string | null;
    /** The port the deploy pinned, from the page's own read. What the live status
     *  reports is the same number; this is what lets the card print it before the
     *  server has said anything. */
    port: number | null;
    running: boolean;
    reach: GameReachAdvice | null;
    access: FivemAccessView | null;
    onOpenSecurity: () => void;
}) {
    const joined = address === null ? null : withPort(address, status?.port ?? port);
    return (
        <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-2">
                    {joined === null ? (
                        status === null ? (
                            <Skeleton className="h-7 w-56" />
                        ) : (
                            <span className="text-sm text-muted-foreground">
                                Not published yet - the address appears once the server has deployed.
                            </span>
                        )
                    ) : (
                        <div className="flex flex-col gap-1">
                            <span className="text-xs text-muted-foreground">
                                In FiveM, press F8 and type this - or paste it into the direct connect box.
                            </span>
                            <span className="flex min-w-0 items-center gap-1">
                                <code className="min-w-0 truncate rounded bg-surface px-2 py-1 font-mono text-sm">
                                    connect {joined}
                                </code>
                                <CopyButton value={`connect ${joined}`} label="the connect command" />
                            </span>
                        </div>
                    )}
                    {status?.build && <span className="text-xs text-muted-foreground">{status.build}</span>}
                    {/* Only when there is something the operator can actually do
                        about it: a probe that proved nothing is not a warning. */}
                    {reach && !reach.ok && reach.actionable && (
                        <span className="text-xs text-warning">{reach.title}</span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {access !== null && (
                        <Button size="sm" variant="secondary" onClick={onOpenSecurity}>
                            <DoorOpen className="size-4" />
                            {access.exclusiveJoin ? "Closed" : "Open to everyone"}
                        </Button>
                    )}
                    <StatusBadge status={status} running={running} />
                </div>
            </CardBody>
        </Card>
    );
}

function OverviewTab({ status }: { status: FivemStatus | null }) {
    const figures: { label: string; value: string }[] = [
        {
            label: "Players",
            value: status?.answering ? `${status.players.length} / ${status.max || "?"}` : "-"
        },
        { label: "Resources running", value: status?.resourcesRunning?.toString() ?? "-" },
        { label: "Name in the browser", value: status?.hostname || "-" },
        {
            label: "Memory",
            value:
                status?.memUsedBytes === null || status?.memUsedBytes === undefined
                    ? "-"
                    : `${Math.round(status.memUsedBytes / (1024 * 1024))} MB`
        }
    ];
    return (
        <div className="flex flex-col gap-4">
            {status?.message && (
                <Card>
                    <CardBody className="flex items-start gap-2 py-3 text-sm text-muted-foreground">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                        <span>{status.message}</span>
                    </CardBody>
                </Card>
            )}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {figures.map((figure) => (
                    <Card key={figure.label}>
                        <CardBody className="flex flex-col gap-1 py-3">
                            <span className="text-xs text-muted-foreground">{figure.label}</span>
                            {status === null ? (
                                <Skeleton className="h-6 w-16" />
                            ) : (
                                <span className="truncate text-lg font-medium" title={figure.value}>
                                    {figure.value}
                                </span>
                            )}
                        </CardBody>
                    </Card>
                ))}
            </div>
        </div>
    );
}

const PLAYER_COLUMNS = [
    { label: "Player" },
    { label: "Known by", className: "hidden md:table-cell" },
    { label: "Standing" },
    { label: "Last seen", className: "hidden sm:table-cell" }
];

function PlayersTab({
    installedAppId,
    status,
    access,
    seen,
    canModerate,
    canManage,
    onChanged
}: {
    installedAppId: string;
    status: FivemStatus | null;
    access: FivemAccessView | null;
    seen: Readonly<Record<string, PlayerSeen>>;
    canModerate: boolean;
    canManage: boolean;
    onChanged: (access?: FivemAccessView) => void;
}) {
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState("all");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [messaging, setMessaging] = useState<FivemPlayerEntry | null>(null);
    const [timing, setTiming] = useState<FivemPlayerEntry | null>(null);
    const [broadcasting, setBroadcasting] = useState(false);
    const [confirm, confirmElement] = useConfirm();

    const rows = useMemo(
        () =>
            foldFivemPlayers(status?.players ?? [], access ?? { allowList: [], bans: [], admins: [] })
                .filter((entry) => matchesFivemPlayer(entry, query))
                .filter((entry) => matchesFivemFilter(entry, filter)),
        [status?.players, access, query, filter]
    );

    async function run(key: string, work: () => Promise<{ access?: FivemAccessView; error?: string }>): Promise<void> {
        setBusy(key);
        setError(null);
        const result = await work();
        setBusy(null);
        if (result.error) {
            setError(result.error);
            return;
        }
        onChanged(result.access);
    }

    return (
        <div className="flex flex-col gap-3">
            {error && <p className="text-sm text-danger">{error}</p>}

            <PlayersTable
                columns={PLAYER_COLUMNS}
                minWidth="46rem"
                search={query}
                onSearch={setQuery}
                searchPlaceholder="Search by name or identifier"
                filter={filter}
                filters={playerFilters({ operators: true })}
                onFilter={setFilter}
                toolbar={
                    canModerate ? (
                        <div className="flex items-center gap-1">
                            <Button size="sm" variant="secondary" onClick={() => setBroadcasting(true)}>
                                <Megaphone className="size-4" /> Announce
                            </Button>
                            <Button size="sm" onClick={() => setAdding(true)}>
                                <UserPlus className="size-4" /> {playerAction.add}
                            </Button>
                        </div>
                    ) : undefined
                }
                isEmpty={rows.length === 0}
                empty={
                    status === null
                        ? "Reading the server..."
                        : status.answering
                          ? "Nobody is playing, and nobody has been added yet."
                          : (status.message ?? "The server is not answering.")
                }
                rows={rows.map((entry) => (
                    <PlayerRow
                        key={entry.identifier ?? `${entry.name}-${entry.playerId}`}
                        entry={entry}
                        seen={seenFor(seen, { id: entry.identifier, names: [entry.name] })}
                        busy={busy === entry.identifier}
                        canModerate={canModerate}
                        canManage={canManage}
                        onAllow={() =>
                            entry.identifier &&
                            void run(entry.identifier, () =>
                                actions.addFivemPlayerAction(installedAppId, entry.identifier!, entry.name)
                            )
                        }
                        onDisallow={async () => {
                            if (!entry.identifier) return;
                            const question = playerConfirm.remove(entry.name);
                            if (!(await confirm({ ...question, confirmLabel: "Remove", danger: true }))) return;
                            void run(entry.identifier, () =>
                                actions.removeFivemPlayerAction(installedAppId, entry.identifier!)
                            );
                        }}
                        onKick={async () => {
                            if (entry.playerId === null) return;
                            const question = playerConfirm.kick(entry.name);
                            if (!(await confirm({ ...question, confirmLabel: "Kick", danger: true }))) return;
                            void run(entry.identifier ?? entry.name, async () =>
                                actions.kickFivemPlayerAction(
                                    installedAppId,
                                    entry.playerId!,
                                    "You were removed from this server."
                                )
                            );
                        }}
                        onBan={async () => {
                            if (!entry.identifier) return;
                            const question = playerConfirm.ban(entry.name);
                            if (!(await confirm({ ...question, confirmLabel: "Ban", danger: true }))) return;
                            void run(entry.identifier, () =>
                                actions.banFivemPlayerAction(
                                    installedAppId,
                                    entry.identifier!,
                                    entry.name,
                                    DEFAULT_BAN_REASON
                                )
                            );
                        }}
                        onPardon={() =>
                            entry.identifier &&
                            void run(entry.identifier, () =>
                                actions.unbanFivemPlayerAction(installedAppId, entry.identifier!)
                            )
                        }
                        onTimeout={() => setTiming(entry)}
                        onMessage={() => setMessaging(entry)}
                        onAdmin={(isAdmin) =>
                            entry.identifier &&
                            void run(entry.identifier, () =>
                                actions.setFivemAdminAction(installedAppId, entry.identifier!, entry.name, isAdmin)
                            )
                        }
                    />
                ))}
            />

            <p className="text-xs text-muted-foreground">
                A player is matched by the identifiers their game hands over, never by the name they chose - two people
                can pick the same name, and either can change it.
            </p>

            {adding && (
                <AddPlayerDialog
                    onClose={() => setAdding(false)}
                    onAdd={(identifier, label) => {
                        setAdding(false);
                        void run(identifier, () => actions.addFivemPlayerAction(installedAppId, identifier, label));
                    }}
                />
            )}
            {messaging && (
                <MessageDialog
                    player={messaging.name}
                    onClose={() => setMessaging(null)}
                    onSend={(message) => {
                        const target = messaging;
                        setMessaging(null);
                        if (target.playerId === null) return;
                        void run(target.identifier ?? target.name, async () =>
                            actions.messageFivemPlayerAction(installedAppId, target.playerId!, message)
                        );
                    }}
                />
            )}
            {broadcasting && (
                <MessageDialog
                    player="everyone"
                    onClose={() => setBroadcasting(false)}
                    onSend={(message) => {
                        setBroadcasting(false);
                        void run("broadcast", async () => actions.broadcastFivemAction(installedAppId, message));
                    }}
                />
            )}
            {timing && (
                <PlayerTimeoutDialog
                    player={timing.name}
                    pending={busy === timing.identifier}
                    onClose={() => setTiming(null)}
                    onTimeout={(minutes, reason) => {
                        const target = timing;
                        setTiming(null);
                        if (!target.identifier) return;
                        void run(target.identifier, () =>
                            actions.banFivemPlayerAction(
                                installedAppId,
                                target.identifier!,
                                target.name,
                                reason || DEFAULT_BAN_REASON,
                                minutes
                            )
                        );
                    }}
                />
            )}
            {confirmElement}
        </div>
    );
}

function PlayerRow({
    entry,
    seen,
    busy,
    canModerate,
    canManage,
    onAllow,
    onDisallow,
    onKick,
    onBan,
    onPardon,
    onTimeout,
    onMessage,
    onAdmin
}: {
    entry: FivemPlayerEntry;
    seen: PlayerSeen | null;
    busy: boolean;
    canModerate: boolean;
    canManage: boolean;
    onAllow: () => void;
    onDisallow: () => void;
    onKick: () => void;
    onBan: () => void;
    onPardon: () => void;
    onTimeout: () => void;
    onMessage: () => void;
    onAdmin: (isAdmin: boolean) => void;
}) {
    // What the line under the name says - see `presenceLine`.
    const line = presenceLine({ online: entry.online, seen, addedAt: entry.addedAt });
    const standing = entry.banned
        ? entry.banned.until
            ? `${playerStanding.banned}, ${timeoutRemaining(entry.banned.until)}`
            : playerStanding.banned
        : entry.waiting
          ? playerStanding.waiting
          : entry.allowed
            ? playerStanding.allowed
            : playerStanding.notAllowed;

    return (
        <tr className="border-t border-border">
            <td className="px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium" title={entry.name}>{entry.name}</span>
                    {entry.admin && <Badge className="shrink-0 text-[11px]">{playerStanding.operator}</Badge>}
                </span>
                <span className="text-xs text-muted-foreground">
                    {entry.online
                        ? `${playerPresence.playing}${entry.ping ? ` - ${entry.ping} ms` : ""}`
                        : playerPresence.offline}
                </span>
            </td>
            <td className="hidden px-3 py-2 md:table-cell">
                <span className="flex flex-wrap gap-1">
                    {entry.identifiers.slice(0, 3).map((identifier) => {
                        const kind = kindOf(identifier);
                        return (
                            <span
                                key={identifier}
                                title={identifier}
                                className="rounded bg-surface px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                            >
                                {kind ? IDENTIFIER_LABEL[kind] : identifier}
                            </span>
                        );
                    })}
                </span>
            </td>
            <td className="px-3 py-2">
                <span
                    className={cn(
                        "text-xs",
                        entry.banned ? "text-danger" : entry.waiting ? "text-warning" : "text-muted-foreground"
                    )}
                >
                    {standing}
                </span>
                {entry.waiting && (
                    <span className="block text-xs text-muted-foreground">
                        Added here; the server is told as soon as it answers.
                    </span>
                )}
            </td>
            <td className="hidden px-3 py-2 text-xs text-muted-foreground sm:table-cell">
                {/* Which of the three things a row can say - see `presenceLine`,
                    where the cases are settled and tested. */}
                {line === null ? (
                    playerPresence.never
                ) : line.kind === "added" ? (
                    <>
                        Added <RelativeTime iso={line.iso} />
                    </>
                ) : (
                    <>
                        {line.kind === "since" ? "Playing since " : "Last on "}
                        <RelativeTime iso={line.iso} />
                    </>
                )}
            </td>
            <td className="px-3 py-2">
                <div className="flex items-center justify-end gap-0.5">
                    {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                    {canModerate && entry.identifier && !entry.allowed && (
                        <PlayerIconAction
                            label={playerAction.allow(entry.name)}
                            icon={<UserPlus className="size-4" />}
                            disabled={busy}
                            onClick={onAllow}
                        />
                    )}
                    {canModerate && entry.identifier && entry.allowed && (
                        <PlayerIconAction
                            label={playerAction.remove(entry.name)}
                            icon={<UserMinus className="size-4" />}
                            disabled={busy}
                            onClick={onDisallow}
                        />
                    )}
                    {canModerate && entry.online && (
                        <PlayerIconAction
                            label={playerAction.kick(entry.name)}
                            icon={<DoorOpen className="size-4" />}
                            disabled={busy}
                            danger
                            onClick={onKick}
                        />
                    )}
                    {canModerate && entry.identifier && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={playerAction.more(entry.name)}
                                    title={playerAction.more(entry.name)}
                                    disabled={busy}
                                >
                                    <MoreHorizontal className="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>{entry.name}</DropdownMenuLabel>
                                {entry.online && (
                                    <DropdownMenuItem onSelect={onMessage}>
                                        <MessageSquare className="size-4" /> {playerMenuItem.message}
                                    </DropdownMenuItem>
                                )}
                                {entry.banned ? (
                                    <DropdownMenuItem onSelect={onPardon}>
                                        <Eye className="size-4" /> {playerMenuItem.pardon}
                                    </DropdownMenuItem>
                                ) : (
                                    <>
                                        <DropdownMenuItem onSelect={onTimeout}>
                                            <Timer className="size-4" /> {playerMenuItem.timeout}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onSelect={onBan}>
                                            <Ban className="size-4" /> {playerAction.ban(entry.name)}
                                        </DropdownMenuItem>
                                    </>
                                )}
                                {canManage && (
                                    <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onSelect={() => onAdmin(!entry.admin)}>
                                            {entry.admin ? (
                                                <>
                                                    <ShieldMinus className="size-4" /> Stop them administering it
                                                </>
                                            ) : (
                                                <>
                                                    <ShieldPlus className="size-4" /> Let them administer it
                                                </>
                                            )}
                                        </DropdownMenuItem>
                                    </>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                </div>
            </td>
        </tr>
    );
}

/** Add somebody who has never connected, by the identifier their game hands over. */
function AddPlayerDialog({
    onClose,
    onAdd
}: {
    onClose: () => void;
    onAdd: (identifier: string, label: string) => void;
}) {
    const [identifier, setIdentifier] = useState("");
    const [label, setLabel] = useState("");
    const invalid = identifier.trim().length > 0 && !isIdentifier(identifier);

    return (
        <PlayerFormDialog
            title={playerAction.add}
            description="They are let in the next time they connect, whether or not they have ever been on this server."
            onClose={onClose}
            pending={false}
            ready={isIdentifier(identifier)}
            confirmLabel="Add"
            onConfirm={() => onAdd(identifier.trim(), label.trim())}
        >
            <PlayerFormField label="Identifier">
                <Input
                    value={identifier}
                    onChange={(event) => setIdentifier(event.target.value)}
                    placeholder="license:0123456789abcdef..."
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                />
                <span className={cn("text-xs", invalid ? "text-danger" : "text-muted-foreground")}>
                    {invalid
                        ? "Paste it whole, as the game gives it: license:... or discord:..."
                        : "Whatever the game hands over - a licence, a Discord id, a Steam id. It is shown beside anybody who has connected."}
                </span>
            </PlayerFormField>
            <PlayerFormField label="Name on the list">
                <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Optional" />
            </PlayerFormField>
        </PlayerFormDialog>
    );
}

function MessageDialog({
    player,
    onClose,
    onSend
}: {
    player: string;
    onClose: () => void;
    onSend: (message: string) => void;
}) {
    const [message, setMessage] = useState("");
    const invalid = message.length > 0 && !isBanReason(message);
    return (
        <PlayerFormDialog
            title={`Message ${player}`}
            description="It appears in the game's chat."
            onClose={onClose}
            pending={false}
            ready={message.trim().length > 0 && !invalid}
            confirmLabel="Send"
            onConfirm={() => onSend(message.trim())}
        >
            <PlayerFormField label="Message">
                <Input value={message} onChange={(event) => setMessage(event.target.value)} maxLength={200} />
                {invalid && <span className="text-xs text-danger">{REASON_HINT}</span>}
            </PlayerFormField>
        </PlayerFormDialog>
    );
}

function ClosedServerCard({
    installedAppId,
    access,
    guardRunning,
    canManage,
    onChanged,
    onOpenPlayers
}: {
    installedAppId: string;
    access: FivemAccessView | null;
    /** Whether the resource that actually turns people away is running. Null when
     *  the server did not say, which is not the same as no. */
    guardRunning: boolean | null;
    canManage: boolean;
    onChanged: (access?: FivemAccessView) => void;
    onOpenPlayers: () => void;
}) {
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const closed = access?.exclusiveJoin ?? false;

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">Only players you add can join</p>
                        <p className="text-xs text-muted-foreground">
                            Everyone else is turned away as they connect, with a line telling them why. FiveM has no
                            list of its own, so this is Polaris&apos; and it is enforced inside the server.
                        </p>
                    </div>
                    <Switch
                        checked={closed}
                        disabled={!canManage || pending || access === null}
                        aria-label="Only players you add can join"
                        onChange={(next: boolean) =>
                            startTransition(async () => {
                                setError(null);
                                const result = await actions.setFivemExclusiveJoinAction(installedAppId, next);
                                if (result.error) {
                                    setError(result.error);
                                    return;
                                }
                                onChanged(result.access);
                            })
                        }
                    />
                </div>
                {error && <p className="text-sm text-danger">{error}</p>}
                {/* The one failure here nobody would otherwise see: the list says
                    closed and there is nothing at the door enforcing it. Polaris
                    puts the resource back on its next read; this is so the state
                    is not silent in the meantime. */}
                {closed && guardRunning === false && (
                    <p className="flex items-start gap-2 text-sm text-warning">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                        <span>
                            The server is not running what turns people away, so anyone with the address can join
                            right now. Polaris puts it back within a few seconds; if this stays, restart the server.
                        </span>
                    </p>
                )}
                <p className="text-xs text-muted-foreground">
                    {access === null
                        ? "Reading the list..."
                        : `${access.allowList.length} on the list, ${access.bans.length} banned.`}{" "}
                    <button type="button" onClick={onOpenPlayers} className="text-primary hover:underline">
                        Open the players screen
                    </button>
                    .
                </p>
            </CardBody>
        </Card>
    );
}

function ConsolePasswordCard({
    installedAppId,
    canManage,
    running
}: {
    installedAppId: string;
    canManage: boolean;
    running: boolean;
}) {
    const [shown, setShown] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [pending, startTransition] = useTransition();
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const invalid = draft.length > 0 && !isConsolePassword(draft);

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                        <KeyRound className="size-4" /> Console password
                    </p>
                    <p className="text-xs text-muted-foreground">
                        What opens the server&apos;s own console. Polaris uses it for everything on these screens; you
                        only need it for a tool of your own.
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    {shown === null ? (
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={pending}
                            onClick={() =>
                                startTransition(async () => {
                                    setError(null);
                                    const result = await actions.revealFivemPasswordAction(installedAppId);
                                    if (result.error) {
                                        setError(result.error);
                                        return;
                                    }
                                    setShown(result.password ?? "");
                                })
                            }
                        >
                            <Eye className="size-4" /> Show it
                        </Button>
                    ) : (
                        <span className="flex min-w-0 items-center gap-1">
                            <code className="min-w-0 truncate rounded bg-surface px-2 py-1 font-mono text-sm">
                                {shown || "There is none recorded"}
                            </code>
                            {shown && <CopyButton value={shown} label="the console password" />}
                        </span>
                    )}
                </div>

                {canManage && (
                    <div className="flex flex-wrap items-end gap-2">
                        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                            <span className="text-muted-foreground">Change it</span>
                            <div className="flex items-center gap-1">
                                <Input
                                    value={draft}
                                    onChange={(event) => setDraft(event.target.value)}
                                    className="font-mono"
                                    autoComplete="off"
                                    spellCheck={false}
                                />
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label="Generate another password"
                                    title="Generate another password"
                                    onClick={() =>
                                        setDraft(
                                            generateConsolePassword((size) =>
                                                crypto.getRandomValues(new Uint8Array(size))
                                            )
                                        )
                                    }
                                >
                                    <RefreshCw className="size-4" />
                                </Button>
                            </div>
                            <span className={cn("text-xs", invalid ? "text-danger" : "text-muted-foreground")}>
                                {invalid ? CONSOLE_PASSWORD_HINT : "It takes effect at once on a running server."}
                            </span>
                        </label>
                        <Button
                            size="sm"
                            disabled={pending || !isConsolePassword(draft) || !running}
                            onClick={() =>
                                startTransition(async () => {
                                    setError(null);
                                    setNote(null);
                                    const result = await actions.setFivemPasswordAction(installedAppId, draft);
                                    if (result.error) {
                                        setError(result.error);
                                        return;
                                    }
                                    setShown(draft);
                                    setDraft("");
                                    setNote("Changed.");
                                })
                            }
                        >
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Change
                        </Button>
                    </div>
                )}
                {!running && canManage && (
                    <p className="text-xs text-muted-foreground">
                        The server has to be running to be told a new one.
                    </p>
                )}
                {note && <p className="text-sm text-success">{note}</p>}
                {error && <p className="text-sm text-danger">{error}</p>}
            </CardBody>
        </Card>
    );
}

function ServerKeyCard({ installedAppId, canManage }: { installedAppId: string; canManage: boolean }) {
    const [draft, setDraft] = useState("");
    const [pending, startTransition] = useTransition();
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const invalid = draft.trim().length > 0 && !isLicenseKey(draft);

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="min-w-0">
                    <p className="text-sm font-medium">Server key</p>
                    <p className="text-xs text-muted-foreground">
                        The free key from{" "}
                        <Link href={KEYMASTER_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                            keymaster
                        </Link>
                        . A key is tied to the address it was issued for, so a server that has moved needs a new one.
                        It is never shown back.
                    </p>
                </div>
                {canManage && (
                    <div className="flex flex-wrap items-end gap-2">
                        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                            <span className="text-muted-foreground">Replace it</span>
                            <Input
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                placeholder="cfxk_..."
                                className="font-mono"
                                autoComplete="off"
                                spellCheck={false}
                            />
                            <span className={cn("text-xs", invalid ? "text-danger" : "text-muted-foreground")}>
                                {invalid ? LICENSE_KEY_HINT : "The server picks it up the next time it starts."}
                            </span>
                        </label>
                        <Button
                            size="sm"
                            disabled={pending || !isLicenseKey(draft)}
                            onClick={() =>
                                startTransition(async () => {
                                    setError(null);
                                    setNote(null);
                                    const result = await actions.setFivemLicenseKeyAction(installedAppId, draft.trim());
                                    if (result.error) {
                                        setError(result.error);
                                        return;
                                    }
                                    setDraft("");
                                    setNote("Saved. Restart the server to run on it.");
                                })
                            }
                        >
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Save
                        </Button>
                    </div>
                )}
                {note && <p className="text-sm text-success">{note}</p>}
                {error && <p className="text-sm text-danger">{error}</p>}
            </CardBody>
        </Card>
    );
}
