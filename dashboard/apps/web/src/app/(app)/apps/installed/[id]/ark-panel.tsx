"use client";

/**
 * The ARK server's own dashboard inside Polaris: where to connect, who is playing,
 * who is allowed to, the console and the settings.
 *
 * Built the same way the Minecraft one is - the same tab bar, the same real paths,
 * the same poll that paints from what the page already knows and fills the live
 * parts in - and it reuses that panel's screens wherever the screen was never about
 * Minecraft: the settings form is manifest-driven, the address picker writes DNS,
 * and sharing a server with somebody is sharing an install.
 *
 * What is genuinely ARK's is the access screen. A server is created closed with
 * nobody on it that it knows about, because at that moment it is still downloading
 * thirty gigabytes and cannot be told anything - so a player can be on the list and
 * not yet on the server, and the two states are drawn differently. Anything else
 * would have a moderator adding somebody, watching nothing happen, and adding them
 * again.
 */

import Link from "next/link";
import { ArkMods } from "./ark-mods";
import { ArkRules } from "./ark-rules";
import * as actions from "./ark-actions";
import { GameConsole } from "./game-console";
import type { Permission } from "@polaris/core";
import type { GameContext } from "./game-context";
import { loadArkCatalog } from "./ark-item-picker";
import { MinecraftAccess } from "./minecraft-access";
import { MinecraftDomain } from "./minecraft-domain";
import { CopyButton } from "@/components/copy-button";
import { useConfirm } from "@/components/confirm-dialog";
import { usePathname, useRouter } from "next/navigation";
import { MinecraftSettings } from "./minecraft-settings";
import type { ArkProfile } from "@/lib/apps/ark/profile";
import { presenceLine, seenFor } from "@/lib/apps/games-activity";
import { RelativeTime } from "@/components/relative-time";
import { ToolbarSwitch } from "@/components/toolbar-switch";
import type { ServerPresence } from "@/lib/apps/games-service";
import { useGamePresence } from "@/components/use-game-presence";
import type { PlayerSeen } from "@/lib/apps/games-activity";
import { findArkMap, mapRequirementHint } from "@/lib/apps/ark/maps";
import { MinecraftSchedule, NO_SCHEDULE } from "./minecraft-schedule";
import type { InstalledAppSetting } from "@/lib/apps/install-service";
import type { ArkAccessView, ArkStatus } from "@/lib/apps/ark/service";
import type { GameReachAdvice } from "@/lib/apps/minecraft/reach-advice";
import { PlayerTimeoutDialog } from "@/components/player-timeout-dialog";
import { PlayerIconAction, PlayersTable } from "@/components/game-players-table";
import { canOpenGameTab, gameTabHref, isGameTab, visibleGameTabs } from "./tabs";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { timeoutFor, timeoutRemaining, type PlayerTimeout } from "@/lib/apps/player-timeout";
import { foldArkPlayers, matchesArkPlayer, type ArkPlayerEntry } from "@/lib/apps/ark/players";
import { generateJoinPassword, isJoinPassword, JOIN_PASSWORD_HINT } from "@/lib/apps/ark/access";
import { CONSUMPTION_METRICS, MetricsHistory, PLAYER_METRICS } from "@/components/metrics-history";
import {
    ArkExperienceDialog,
    ArkGiveDialog,
    ArkHistoryDialog,
    ArkMessageDialog,
    ArkPlayerDialog
} from "./ark-player-dialogs";
import {
    playerAction,
    playerConfirm,
    playerFilters,
    playerMenuItem,
    playerPresence,
    playerStanding
} from "@/lib/apps/player-vocabulary";
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
import {
    Ban,
    Clock,
    Crown,
    DoorOpen,
    Eye,
    FolderOpen,
    Timer,
    Loader2,
    Megaphone,
    MessageSquare,
    MoreHorizontal,
    PackageMinus,
    PackagePlus,
    Pencil,
    RefreshCw,
    Save,
    ShieldAlert,
    Skull,
    Sparkles,
    ShieldMinus,
    ShieldPlus,
    UserMinus,
    UserPlus,
    Users
} from "lucide-react";

/**
 * How long after one read finishes before the next one starts. Measured from the
 * end rather than on a fixed interval: a read runs a command inside the container
 * and a slow one would otherwise have every tick queue behind the last.
 *
 * Unhurried, because the thing that changes by itself is not read here any more.
 * Who is playing arrives on the live stream within a couple of seconds of it
 * happening; what this poll is for - what the machine is costing, whether the port
 * answers from outside, what the server was launched with - moves slowly enough
 * that asking every few seconds was only ever noise.
 */
const POLL_MS = 12000;

/** How old a streamed reading may be before the screen stops preferring it to what
 *  the poll last returned. Several times the stream's own cadence, so a frame that
 *  is merely between beats is still trusted, and a connection that has silently
 *  died is not. */
const PRESENCE_STALE_MS = 25000;

/** Managed by the Access screen's own controls rather than offered twice as raw
 *  fields - the two would quietly disagree about what the server is running on. */
const SECURITY_GROUP = "Security";

/** The same, for the mod list and the map mod: the Mods screen owns both, and a
 *  second free-text field for a comma-separated list of ids is how a load order
 *  somebody arranged gets flattened by accident. */
const MODS_GROUP = "Mods";

interface ServerReading {
    status: ArkStatus | null;
    /** What a player types to connect. Worked out from the same read the list
     *  uses, so the two cannot disagree. Null until the first poll answers. */
    address: string | null;
    /** What is still in the way of players outside this network, as of the last
     *  poll. Null until the first one answers. */
    reach: GameReachAdvice | null;
    access: ArkAccessView | null;
    /** Bans with an end, and when each one lifts. Keyed by Steam id, which is what
     *  ARK bans by. */
    timeouts: readonly PlayerTimeout[];
    /** The Steam ids that may administer the server without its password, as the
     *  file on disk has them. */
    admins: readonly string[];
    /** What each survivor's own file says about them, by Steam id. */
    profiles: Readonly<Record<string, ArkProfile>>;
    /** When each of them was last on, by lowercased name. Polaris's own record:
     *  the game knows who is connected and nothing about a minute ago. */
    seen: Readonly<Record<string, PlayerSeen>>;
}

export function ArkPanel({
    installedAppId,
    applicationId,
    settings,
    running,
    game,
    held,
    onStatus
}: {
    installedAppId: string;
    applicationId: string | null;
    settings: InstalledAppSetting[];
    running: boolean;
    /** The server's address suffix, its name on the domain, and what still has to
     *  be opened for players outside this network. */
    game: GameContext | null;
    held: readonly Permission[];
    onStatus?: (label: string | null) => void;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const tab = useMemo(() => {
        const base = `/apps/installed/${installedAppId}`;
        const slug = pathname.startsWith(base)
            ? pathname.slice(base.length).replace(/^\//, "")
            : "";
        return isGameTab(slug, "ark") && canOpenGameTab(slug, held, "ark") ? slug : "";
    }, [pathname, installedAppId, held]);
    const tabs = useMemo(() => visibleGameTabs(held, "ark"), [held]);
    const openTab = useCallback(
        (slug: string) => {
            if (slug === tab) return;
            window.history.pushState(null, "", gameTabHref(installedAppId, slug));
        },
        [installedAppId, tab]
    );

    // Everything the page already knew is on screen before a single request goes
    // out: where to connect, and who is on the list. Only what nobody can answer
    // without asking the server itself - who is playing, what it is costing, and
    // whether its ports answer from outside - waits on the poll.
    const [reading, setReading] = useState<ServerReading>({
        status: null,
        address: game?.address ?? null,
        reach: null,
        access: game?.arkAccess ?? null,
        timeouts: [],
        admins: [],
        profiles: {},
        seen: {}
    });
    const [error, setError] = useState<string | null>(null);
    /** What Polaris last said it intends the server to do. Kept so the page can
     *  re-read itself when that changes underneath it - a start, a stop, or a
     *  schedule that fired while somebody was looking at the screen. */
    const intended = useRef(running);

    // The survivors and the admin list are two more reads inside the container, so
    // they are only asked for by the screen that draws them.
    const wantsPlayers = tab === "players";

    const load = useCallback(async () => {
        try {
            const response = await fetch(
                `/api/apps/installed/${installedAppId}/ark${wantsPlayers ? "?players=1" : ""}`,
                { cache: "no-store" }
            );
            const data = (await response.json()) as {
                status?: ArkStatus;
                address?: string | null;
                reach?: GameReachAdvice | null;
                access?: ArkAccessView | null;
                timeouts?: PlayerTimeout[];
                admins?: string[];
                profiles?: Record<string, ArkProfile>;
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
                timeouts: data.timeouts ?? current.timeouts,
                // Kept between polls of the same screen rather than dropped, so a
                // column does not blink empty on a read the container was too busy
                // to answer.
                admins: data.admins ?? (wantsPlayers ? current.admins : []),
                profiles: data.profiles ?? (wantsPlayers ? current.profiles : {}),
                seen: data.seen ?? (wantsPlayers ? current.seen : {})
            }));
            // The header's Start and Stop, and everything else the page rendered
            // on the server, come from the install row. A poll that finds the
            // server in the other state is that row having gone stale, and
            // without this the only way back was reloading by hand.
            if (data.status.running !== intended.current) {
                intended.current = data.status.running;
                router.refresh();
            }
        } catch {
            // Transient; the next poll retries.
        }
    }, [installedAppId, wantsPlayers, router]);

    // Scheduled from the end of a read rather than on a fixed interval: asking an
    // ARK server anything is a command inside its container, and a slow one would
    // otherwise have polls stacking up behind each other.
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
                { game: game?.gamePort ?? null, query: game?.queryPort ?? null },
                running
            ),
        [reading.status, streamed, presence.at, game?.gamePort, game?.queryPort, running]
    );
    // What the poll knows beats what the page was rendered with: the second is a
    // snapshot from whenever it was opened, and reading them together is how a
    // server that had just been started kept saying it was stopped.
    const isRunning = status?.running ?? running;

    useEffect(() => {
        onStatus?.(statusLabel(reading.status, isRunning));
    }, [onStatus, reading.status, isRunning]);

    const reloadSettings = useCallback(() => {
        router.refresh();
        void load();
    }, [router, load]);

    return (
        <div className="flex flex-col gap-4">
            <ConnectCard
                status={status}
                address={reading.address}
                ports={{ game: game?.gamePort ?? null, query: game?.queryPort ?? null }}
                running={isRunning}
                settings={settings}
                installedAppId={installedAppId}
                applicationId={applicationId}
                reach={reading.reach}
                access={reading.access}
                canSaveWorld={held.includes("games.moderate")}
                onOpenAccess={() => openTab("players")}
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
                        {entry.label}
                    </a>
                ))}
            </nav>

            {tab === "" && <OverviewTab status={status} settings={settings} />}
            {tab === "console" && (
                <GameConsole
                    installedAppId={installedAppId}
                    applicationId={applicationId}
                    running={isRunning}
                    logName="ark"
                    hint="ListPlayers, or Broadcast Server restarting in 5"
                    game="ark"
                    players={(status?.players ?? []).map((player) => player.name)}
                />
            )}
            {tab === "players" && (
                <PlayersTab
                    installedAppId={installedAppId}
                    status={status}
                    access={reading.access}
                    timeouts={reading.timeouts}
                    admins={reading.admins}
                    profiles={reading.profiles}
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
                <ArkMods
                    installedAppId={installedAppId}
                    canManage={held.includes("games.manage")}
                    running={isRunning}
                />
            )}
            {tab === "rules" && (
                <ArkRules
                    installedAppId={installedAppId}
                    canManage={held.includes("games.manage")}
                    running={isRunning}
                />
            )}
            {tab === "usage" &&
                (applicationId ? (
                    <div className="space-y-4">
                        {/* The one an operator opens this tab for: what the box
                            cost only means something beside how many it carried. */}
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
                        canManage={held.includes("games.manage")}
                        onChanged={() => void load()}
                    />
                    <PasswordCard
                        installedAppId={installedAppId}
                        canManage={held.includes("games.manage")}
                    />
                    <MinecraftSettings
                        installedAppId={installedAppId}
                        settings={settings.filter((setting) => setting.group === SECURITY_GROUP)}
                        playersOnline={status?.players.length ?? 0}
                        running={isRunning}
                        onSaved={reloadSettings}
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
                    <MinecraftSettings
                        installedAppId={installedAppId}
                        settings={settings.filter(
                            (setting) => setting.group !== SECURITY_GROUP && setting.group !== MODS_GROUP
                        )}
                        playersOnline={status?.players.length ?? 0}
                        running={isRunning}
                        onSaved={reloadSettings}
                    />
                </div>
            )}
        </div>
    );
}

function ConnectCard({
    status,
    address,
    ports,
    running,
    settings,
    installedAppId,
    applicationId,
    reach,
    access,
    canSaveWorld,
    onOpenAccess
}: {
    status: ArkStatus | null;
    address: string | null;
    /** The ports the deploy pinned, from the page's own read. What the live status
     *  reports is the same pair; this is what lets the card print them before the
     *  server has said anything. */
    ports: { game: number | null; query: number | null };
    running: boolean;
    settings: InstalledAppSetting[];
    installedAppId: string;
    applicationId: string | null;
    reach: GameReachAdvice | null;
    access: ArkAccessView | null;
    canSaveWorld: boolean;
    onOpenAccess: () => void;
}) {
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState<string | null>(null);
    const map = settings.find((setting) => setting.key === "SERVER_MAP")?.value ?? "";
    const session = settings.find((setting) => setting.key === "SESSION_NAME")?.value ?? "";

    async function saveWorld(): Promise<void> {
        setSaving(true);
        const result = await actions.saveArkWorldAction(installedAppId);
        setSaving(false);
        setSaved(result.error ?? "World saved");
    }

    return (
        <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-2">
                    {address === null ? (
                        status === null ? (
                            <Skeleton className="h-7 w-56" />
                        ) : (
                            <span className="text-sm text-muted-foreground">
                                Not published yet - the address appears once the server has
                                deployed.
                            </span>
                        )
                    ) : (
                        <>
                            {/* Two addresses, because ARK is joined two ways and each
                                takes a different port. Showing only one was worth an
                                evening: pasted into Steam, the connect address is
                                answered with "server not found", which names neither
                                the port nor the mistake. */}
                            <JoinAddress
                                title="Add in Steam, or the in-game browser"
                                value={withPort(address, status?.queryPort ?? ports.query)}
                                detail="Steam, View, Servers, Favorites, +. It appears in ARK under Favorites."
                            />
                            <JoinAddress
                                title="Or connect straight to it"
                                value={`open ${withPort(address, status?.gamePort ?? ports.game)}`}
                                detail="In a loaded single-player world, press Tab and type this. ARK has no console on its menu."
                            />
                        </>
                    )}
                    <span className="text-xs text-muted-foreground">
                        {[findArkMap(map)?.label ?? map, session].filter(Boolean).join(" - ")}
                    </span>
                    {/* The map is half of whether anybody can join, and it fails
                        silently: a player without it is bounced to ARK's main menu
                        while Steam opens on the store page, with nothing on either
                        screen naming the map. From here it looks like a server
                        refusing connections. */}
                    {findArkMap(map)?.requires !== "base" && (
                        <span className="text-xs text-warning">
                            {mapRequirementHint(findArkMap(map))}
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-3">
                    <StatusBadge status={status} running={running} />
                    {applicationId && (
                        <Link href={`/drive?c=container:${applicationId}&p=/app`}>
                            <Button
                                size="sm"
                                variant="secondary"
                                title="Browse this server's files in Drive"
                            >
                                <FolderOpen className="size-4" /> Files
                            </Button>
                        </Link>
                    )}
                    {canSaveWorld && (
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void saveWorld()}
                            disabled={saving || !(status?.answering ?? false)}
                            title="Write the world to disk now"
                        >
                            {saving ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <Save className="size-4" />
                            )}
                            Save world
                        </Button>
                    )}
                </div>
                {saved && <p className="w-full text-xs text-muted-foreground">{saved}</p>}

                {/* A server that lets in only the players it was told about, and was
                    never told about anybody, is a server nobody can join - the state
                    a brand-new one is in until it finishes installing. */}
                {access !== null &&
                    access.closed &&
                    access.players.every((player) => player.appliedAt === null) && (
                        <div className="flex w-full items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
                            <UserPlus className="mt-0.5 size-4 shrink-0 text-warning" />
                            <div className="flex flex-col items-start gap-1 text-xs">
                                <p className="font-medium text-foreground">Nobody can join yet</p>
                                <p className="text-muted-foreground">
                                    This server only lets in players it has been told about, and it
                                    has not been told about anybody yet - it is still installing.
                                    Polaris hands the list over as soon as the server answers;
                                    nothing else is needed.
                                </p>
                                <button
                                    type="button"
                                    onClick={onOpenAccess}
                                    className="text-primary hover:underline"
                                >
                                    See who is on the list
                                </button>
                            </div>
                        </div>
                    )}

                {reach && !reach.ok && reach.actionable && (
                    <div className="flex w-full items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
                        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                        <div className="flex flex-col gap-1 text-xs">
                            <p className="font-medium text-foreground">{reach.title}</p>
                            <p className="text-muted-foreground">{reach.detail}</p>
                            {reach.steps.length > 0 && (
                                <ul className="ml-4 list-disc text-muted-foreground">
                                    {reach.steps.map((step) => (
                                        <li key={step}>{step}</li>
                                    ))}
                                </ul>
                            )}
                            {reach.forward && (
                                <Link
                                    href="/admin/domains#game-ports"
                                    className="w-fit text-primary hover:underline"
                                >
                                    Open the router walkthrough
                                </Link>
                            )}
                        </div>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}

/** The same host on another port. The address a server is published at carries the
 *  port a client connects on; the browser wants a different one, and the host is
 *  the only part they share. */
function withPort(address: string, port: number | null): string {
    const host = address.replace(/:\d+$/, "");
    return port === null ? address : `${host}:${port}`;
}

/** One address, what it is for, and a button that copies it - which is the only
 *  thing anybody actually does with it. */
function JoinAddress({ title, value, detail }: { title: string; value: string; detail: string }) {
    return (
        <div className="flex min-w-0 flex-col">
            <span className="text-xs text-muted-foreground">{title}</span>
            <div className="flex items-center gap-2">
                <code className="truncate font-mono text-base" title={value}>
                    {value}
                </code>
                <CopyButton value={value} label={`Copy: ${title}`} />
            </div>
            <span className="text-xs text-muted-foreground">{detail}</span>
        </div>
    );
}

/**
 * The reading the screen shows: what the poll last returned, with the streamed
 * presence laid over it.
 *
 * A frame carries who is on and nothing else - not what the machine is costing,
 * not which ports it was launched with - so it is laid over the fuller reading
 * rather than replacing it. Before the first poll has answered there is nothing to
 * lay it over, and the parts a frame does not carry are the ones the page already
 * knew: a table of who is playing appears in the second or so the stream takes,
 * rather than waiting on a command inside a container.
 */
function withPresence(
    status: ArkStatus | null,
    presence: ServerPresence | null,
    ports: { game: number | null; query: number | null },
    running: boolean
): ArkStatus | null {
    if (!presence) return status;
    // A player with no id is not one this screen can act on - every verb ARK has
    // is written against the Steam id - and ARK always reports one.
    const players = presence.players.flatMap((player) =>
        player.id ? [{ name: player.name, steamId: player.id }] : []
    );
    const live = {
        answering: presence.answering,
        containerRunning: presence.containerRunning,
        players,
        message: presence.message,
        crashLoop: presence.crashLoop
    };
    if (status) return { ...status, ...live };
    return {
        ...live,
        running,
        max: presence.max || null,
        gamePort: ports.game,
        queryPort: ports.query,
        cpuPercent: null,
        memUsedBytes: null,
        memTotalBytes: null,
        crashLoop: presence.crashLoop
    };
}

/** What the server is doing, in one word. "Meant to be running" and "running" are
 *  different things, and the header is told which. */
function statusLabel(status: ArkStatus | null, running: boolean): string | null {
    if (status === null) return null;
    // Before either of the two words below, both of which a looping container is
    // momentarily entitled to and neither of which is the useful one.
    if (status.crashLoop) return "Crash loop";
    if (!running || !status.running) return "Stopped";
    if (status.containerRunning === false) return "Not running";
    return status.answering ? "Online" : "Starting";
}

function StatusBadge({ status, running }: { status: ArkStatus | null; running: boolean }) {
    const label = statusLabel(status, running);
    if (label === null) return <Skeleton className="h-6 w-20" />;
    if (label === "Crash loop") return <Badge variant="danger">Crash loop</Badge>;
    if (label === "Not running") return <Badge variant="danger">Not running</Badge>;
    if (label === "Starting")
        return <Badge className="border-warning/40 text-warning">Starting</Badge>;
    if (label === "Stopped") return <Badge>Stopped</Badge>;
    return (
        <Badge className="border-success/40 text-success">
            {status?.players.length} / {status?.max ?? "?"} online
        </Badge>
    );
}

/** Bytes as an operator reads them, which is the nearest whole unit. */
function formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function OverviewTab({
    status,
    settings
}: {
    status: ArkStatus | null;
    settings: InstalledAppSetting[];
}) {
    const shown = useMemo(
        () =>
            settings.filter((setting) =>
                [
                    "SERVER_MAP",
                    "SESSION_NAME",
                    "MAX_PLAYERS",
                    "GAME_MOD_IDS",
                    "ENABLE_CROSSPLAY"
                ].includes(setting.key)
            ),
        [settings]
    );

    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
                <CardBody className="flex flex-col gap-3">
                    <p className="text-sm font-medium">Playing now</p>
                    {status === null ? (
                        <Skeleton className="h-8 w-full" />
                    ) : !status.answering ? (
                        <p className="text-sm text-muted-foreground">
                            {status.message ?? "The server is not answering."}
                        </p>
                    ) : status.players.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Nobody is playing right now.
                        </p>
                    ) : (
                        <div className="flex flex-wrap gap-1">
                            {status.players.map((player) => (
                                <span
                                    key={player.steamId}
                                    title={player.steamId}
                                    className="rounded-md border border-border px-2 py-1 text-sm"
                                >
                                    {player.name}
                                </span>
                            ))}
                        </div>
                    )}
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-2">
                    <p className="text-sm font-medium">Machine</p>
                    {status === null ? (
                        <Skeleton className="h-10 w-full" />
                    ) : status.cpuPercent === null && status.memUsedBytes === null ? (
                        <p className="text-sm text-muted-foreground">
                            Usage is measured on servers Polaris runs itself.
                        </p>
                    ) : (
                        <dl className="flex flex-col gap-1 text-sm">
                            <div className="flex items-baseline justify-between gap-3">
                                <dt className="text-muted-foreground">Processor</dt>
                                <dd>
                                    {status.cpuPercent === null
                                        ? "-"
                                        : `${status.cpuPercent.toFixed(1)}%`}
                                </dd>
                            </div>
                            <div className="flex items-baseline justify-between gap-3">
                                <dt className="text-muted-foreground">Memory</dt>
                                <dd>
                                    {status.memUsedBytes === null
                                        ? "-"
                                        : `${formatBytes(status.memUsedBytes)}${status.memTotalBytes ? ` of ${formatBytes(status.memTotalBytes)}` : ""}`}
                                </dd>
                            </div>
                        </dl>
                    )}
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-2">
                    <p className="text-sm font-medium">World</p>
                    <dl className="flex flex-col gap-1 text-sm">
                        {shown.map((setting) => {
                            const value =
                                setting.options?.find((option) => option.value === setting.value)
                                    ?.label ??
                                setting.value ??
                                "-";
                            return (
                                <div
                                    key={setting.key}
                                    className="flex items-baseline justify-between gap-3"
                                >
                                    <dt className="text-muted-foreground">{setting.label}</dt>
                                    <dd className="truncate text-right" title={value}>
                                        {value || "-"}
                                    </dd>
                                </div>
                            );
                        })}
                    </dl>
                </CardBody>
            </Card>
        </div>
    );
}

/**
 * Everyone the server knows about, as one row per person.
 *
 * The same table the Minecraft screen is drawn in - see `game-players-table` -
 * with the columns and the verbs ARK actually has. Who is playing and who is
 * allowed on are folded into one row, because they are two halves of one question
 * and a card each meant reading both to work out what is going on with somebody.
 *
 * Adding somebody is a button and a form, like every other screen here. It used to
 * be two fields parked under the table, which read as part of the table, offered no
 * way to correct a name once it was saved, and put a seventeen-digit number in a
 * box the width of whatever space was left.
 *
 * Teleport is not here, and that is not an omission. ARK's teleport commands move
 * a player relative to the admin's own character, and there is no character behind
 * an RCON session - the server takes the command and does nothing, silently. It
 * stays an in-game command, and the screen says so rather than offering a button
 * that would do nothing.
 */
function PlayersTab({
    installedAppId,
    status,
    access,
    timeouts,
    admins,
    profiles,
    seen,
    canModerate,
    canManage,
    onChanged
}: {
    installedAppId: string;
    status: ArkStatus | null;
    access: ArkAccessView | null;
    /** Bans with an end, so a row can say how much of one is left. */
    timeouts: readonly PlayerTimeout[];
    /** Who may administer the server from inside the game, as its own file has it. */
    admins: readonly string[];
    /** What each survivor's file says: their level, and the name they gave
     *  themselves rather than the one Steam knows them by. */
    profiles: Readonly<Record<string, ArkProfile>>;
    /** When each of them was last on, by lowercased name. */
    seen: Readonly<Record<string, PlayerSeen>>;
    canModerate: boolean;
    /** Whether they may change what the list means, which is a heavier grant than
     *  being allowed to add somebody to it. */
    canManage: boolean;
    onChanged: (access?: ArkAccessView) => void;
}) {
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState("all");
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();
    /** The form that is open, and who it is about. Null for the add form, which is
     *  about nobody yet. */
    const [acting, setActing] = useState<{
        entry: ArkPlayerEntry | null;
        dialog: "player" | "message" | "timeout" | "history" | "give" | "experience";
    } | null>(null);
    /** What has been handed out here lately, so the item grid opens on something
     *  worth looking at rather than on the first hundred of two thousand. */
    const [recentItems, setRecentItems] = useState<readonly string[]>([]);
    /** A refusal belongs in the dialog that asked for it, not behind it on a page
     *  the reader has stopped looking at. */
    const [dialogError, setDialogError] = useState<string | null>(null);

    /**
     * Fetch what the item grid needs before anybody asks for it.
     *
     * Two thousand items and the list of what was handed out lately are both
     * wanted by one dialog, and both used to be fetched at the moment it opened -
     * so the first give of a session opened on "Loading the items..." for as long
     * as that took. Started here instead, while somebody is still reading the
     * table: by the time a row's menu has been opened and an item chosen, it has
     * been in memory for several seconds.
     *
     * Only for somebody who could give anything. A viewer who may just read the
     * list pays nothing for a grid they will never open.
     */
    useEffect(() => {
        if (!canModerate) return;
        void loadArkCatalog().catch(() => undefined);
        void actions
            .recentArkItemsAction(installedAppId)
            .then((answer) => setRecentItems(answer.items))
            .catch(() => undefined);
    }, [canModerate, installedAppId]);

    const players = useMemo(
        () => foldArkPlayers(status?.players ?? [], access?.players ?? []),
        [status?.players, access?.players]
    );
    const shown = useMemo(
        () =>
            players
                .filter((entry) => matchesArkPlayer(entry, query))
                .filter((entry) =>
                    filter === "online"
                        ? entry.online
                        : filter === "allowed"
                          ? entry.standing !== "not-allowed"
                          : filter === "operators"
                            ? admins.includes(entry.steamId)
                            : filter === "banned"
                              ? timeoutFor(timeouts, entry.steamId) !== null
                              : true
                ),
        [players, query, filter, admins, timeouts]
    );

    function run(
        work: () => Promise<{ error?: string; access?: ArkAccessView }>,
        done?: string
    ): void {
        setError(null);
        setNote(null);
        startTransition(async () => {
            const result = await work();
            if (result.error) {
                setError(result.error);
                return;
            }
            if (done) setNote(done);
            onChanged(result.access);
        });
    }

    /**
     * Say it happened, then make it happen.
     *
     * For the verbs that reach a running server through two container calls - one
     * to find the number the game knows a player by, one to run the command - which
     * together take seconds. Waiting them out with a spinner in an open dialog made
     * handing somebody a stack of wood feel like a deploy, and the wait bought
     * nothing: ARK answers a give with silence either way, so there was never a
     * confirmation at the end of it to be worth waiting for.
     *
     * So the dialog closes and the line appears at once. What is genuinely
     * uncertain - whether the server took it - is what the line already says. A
     * refusal replaces it with the reason, in the same place, naming what was being
     * attempted: this is the rollback, and it has to be as loud as the claim it
     * withdraws.
     */
    function runOptimistic(
        work: () => Promise<{ error?: string }>,
        said: string,
        /** The failure, worded so it stands on its own - by the time it lands, the
         *  form that asked for it is closed and gone. */
        failed: (reason: string) => string
    ): void {
        setActing(null);
        setDialogError(null);
        setError(null);
        setNote(said);
        startTransition(async () => {
            const result = await work();
            if (!result.error) return;
            setNote(null);
            setError(failed(result.error));
        });
    }

    /** The same for the forms: what failed is shown inside the dialog, and the
     *  dialog only closes once the server has agreed. */
    function runInDialog(
        work: () => Promise<{ error?: string; access?: ArkAccessView }>,
        done?: string
    ): void {
        setDialogError(null);
        startTransition(async () => {
            const result = await work();
            if (result.error) {
                setDialogError(result.error);
                return;
            }
            setActing(null);
            if (done) setNote(done);
            onChanged(result.access);
        });
    }

    /** Whether the server lets in anybody it was not told about. Applied on the
     *  next start, which the card under the table says. */
    function onSetClosed(closed: boolean): void {
        run(() => actions.setArkExclusiveJoinAction(installedAppId, closed));
    }

    function open(
        dialog: "player" | "message" | "timeout" | "history" | "give" | "experience",
        entry: ArkPlayerEntry | null
    ): void {
        setDialogError(null);
        setActing({ entry, dialog });
        // Normally already in hand - see the warm-up above. This is the second
        // chance for a tab where that failed, and it costs nothing when it did not.
        if (dialog === "give" && recentItems.length === 0) {
            void actions.recentArkItemsAction(installedAppId).then((answer) => setRecentItems(answer.items));
        }
    }

    const answering = status?.answering ?? false;
    const listed = access?.players.length ?? 0;
    // The row a form is about, as a value rather than a field, so the callbacks
    // inside a dialog still know it cannot be null.
    const target = acting?.entry ?? null;

    return (
        <div className="flex flex-col gap-4">
            {error && <p className="text-sm text-danger">{error}</p>}
            {note && <p className="text-sm text-muted-foreground">{note}</p>}

            {/* A server that lets in only the players it was told about, and was
                told about nobody, is a server nobody on earth can join - and
                nothing in the game says why. It is also the state a server lands
                in when the last person on the list is removed. */}
            {access !== null && access.closed && listed === 0 && (
                <Card className="border-warning/40 bg-warning/5">
                    <CardBody className="flex flex-col gap-1">
                        <p className="flex items-center gap-2 text-sm font-medium">
                            <Users className="size-4 text-warning" />
                            Nobody can join yet
                        </p>
                        <p className="text-sm text-muted-foreground">
                            This server only lets in players it has been told about, and the list is
                            empty. Add yourself first: your Steam id is the number at the end of
                            your Steam profile URL.
                        </p>
                    </CardBody>
                </Card>
            )}

            {canModerate && <Broadcast installedAppId={installedAppId} answering={answering} />}

            {/* Bare, like the Minecraft table it is the same component as. The
                table draws its own surface, and the card around it was a second
                border inside the first. */}
            <PlayersTable
                columns={[
                    { label: "Player" },
                    { label: "Level" },
                    { label: "Steam id", className: "hidden md:table-cell" },
                    { label: "Status" },
                    { label: "May join" }
                ]}
                search={query}
                onSearch={setQuery}
                searchPlaceholder="Search by name or Steam id"
                filter={filter}
                onFilter={setFilter}
                // Named once for every game - see `player-vocabulary`. Operators
                // are offered because ARK does have a list of them after all - the
                // Steam ids allowed to run admin commands without the password.
                filters={playerFilters({ operators: true })}
                toolbar={
                    <>
                        {/* Whether the list underneath is enforced at all, above
                            the list itself - the same place Minecraft keeps its
                            whitelist switch. It used to live on the Security
                            screen, which is the one place somebody reading the
                            list would never see it, and a list nobody is checked
                            against is the commonest way to think you are private
                            and not be. */}
                        {canManage && (
                            <ToolbarSwitch
                                label={{ on: "List enforced", off: "Anyone may join" }}
                                checked={access?.closed ?? false}
                                disabled={pending || access === null}
                                onChange={onSetClosed}
                            />
                        )}
                        {canModerate && (
                            <Button onClick={() => open("player", null)} disabled={pending}>
                                <UserPlus className="size-4" /> {playerAction.add}
                            </Button>
                        )}
                    </>
                }
                isEmpty={shown.length === 0}
                empty={
                    players.length === 0
                        ? (status?.message ?? "Nobody is on the list and nobody is playing.")
                        : "Nobody matches that."
                }
                rows={shown.map((entry) => (
                    <ArkPlayerRow
                        key={entry.steamId}
                        entry={entry}
                        live={status !== null}
                        canModerate={canModerate}
                        canManage={canManage}
                        answering={answering}
                        pending={pending}
                        profile={profiles[entry.steamId] ?? null}
                        seen={seenFor(seen, {
                            id: entry.steamId,
                            names: [entry.name, profiles[entry.steamId]?.characterName ?? ""]
                        })}
                        admin={admins.includes(entry.steamId)}
                        onAdmin={(next) =>
                            run(
                                () => actions.setArkAdminAction(installedAppId, entry.steamId, next),
                                next
                                    ? `${entry.name} administers this server from its next start.`
                                    : `${entry.name} stops administering it at its next start.`
                            )
                        }
                        timeout={timeoutFor(timeouts, entry.steamId)}
                        onTimeout={() => open("timeout", entry)}
                        onAllow={() =>
                            run(() =>
                                actions.addArkPlayerAction(
                                    installedAppId,
                                    entry.steamId,
                                    entry.name
                                )
                            )
                        }
                        onRemove={() =>
                            void confirm({
                                ...playerConfirm.remove(entry.name),
                                confirmLabel: "Remove",
                                danger: true
                            }).then((agreed) => {
                                if (agreed)
                                    run(() =>
                                        actions.removeArkPlayerAction(installedAppId, entry.steamId)
                                    );
                            })
                        }
                        onEdit={() => open("player", entry)}
                        onHistory={() => open("history", entry)}
                        onMessage={() => open("message", entry)}
                        onGive={() => open("give", entry)}
                        onExperience={() => open("experience", entry)}
                        onKill={() =>
                            void confirm({
                                title: `Kill ${entry.name}?`,
                                description: "Their survivor dies where they are standing and drops everything they were carrying. The body can be looted by anybody who reaches it first.",
                                confirmLabel: "Kill them",
                                danger: true
                            }).then((agreed) => {
                                if (agreed) {
                                    runOptimistic(
                                        () =>
                                            actions.actOnArkSurvivorAction(
                                                installedAppId,
                                                entry.steamId,
                                                "kill"
                                            ),
                                        "Sent to the server. ARK does not answer a kill, so watch the game.",
                                        (reason) => `${entry.name} was not killed: ${reason}`
                                    );
                                }
                            })
                        }
                        onStrip={() =>
                            void confirm({
                                title: `Empty ${entry.name}'s inventory?`,
                                description: "Everything they are carrying, wearing and holding in a slot is destroyed rather than dropped. There is no undo.",
                                confirmLabel: "Empty it",
                                danger: true
                            }).then((agreed) => {
                                if (agreed) {
                                    runOptimistic(
                                        () =>
                                            actions.actOnArkSurvivorAction(
                                                installedAppId,
                                                entry.steamId,
                                                "strip"
                                            ),
                                        "Sent to the server.",
                                        (reason) => `${entry.name}'s inventory was left alone: ${reason}`
                                    );
                                }
                            })
                        }
                        onKick={() =>
                            void confirm({
                                ...playerConfirm.kick(entry.name),
                                confirmLabel: "Kick",
                                danger: true
                            }).then((agreed) => {
                                if (agreed) {
                                    run(
                                        () =>
                                            actions.moderateArkPlayerAction(
                                                installedAppId,
                                                entry.steamId,
                                                "kick"
                                            ),
                                        `${entry.name} was kicked.`
                                    );
                                }
                            })
                        }
                        onBan={() =>
                            void confirm({
                                ...playerConfirm.ban(entry.name),
                                confirmLabel: "Ban",
                                danger: true
                            }).then((agreed) => {
                                if (agreed) {
                                    run(
                                        () =>
                                            actions.moderateArkPlayerAction(
                                                installedAppId,
                                                entry.steamId,
                                                "ban"
                                            ),
                                        `${entry.name} is banned.`
                                    );
                                }
                            })
                        }
                        onUnban={() =>
                            // Through the timeout service rather than the bare
                            // command: somebody let back in early has to have their
                            // note forgotten too, or the sweep would find it later
                            // and unban a person nobody had banned since.
                            run(
                                () => actions.liftArkTimeoutAction(installedAppId, entry.steamId),
                                `The ban on ${entry.name} is lifted.`
                            )
                        }
                    />
                ))}
            />

            <p className="text-xs text-muted-foreground">
                Enforcing the list takes effect the next time the server starts, and is on top of the
                join password. Adding and removing somebody reaches a running server at once.
            </p>

            <p className="text-xs text-muted-foreground">
                An operator runs admin commands in game without typing the admin password. ARK reads
                that list only when it starts, so somebody made an operator now becomes one at the
                next restart. Levels come from each survivor&apos;s own file, so somebody who has
                never played here has none - and neither has anybody the server has no file for,
                which is what a dash in that column means. When they were last on is Polaris&apos;
                own record: ARK can say who is connected this second and nothing about a minute
                ago, so it starts from the day Polaris first watched this server.
            </p>

            <p className="text-xs text-muted-foreground">
                Teleporting to a player is not possible from here: ARK moves players relative to an
                admin&apos;s own character, and Polaris talks to the server without one. In game,
                press Tab and use <code className="font-mono">enablecheats</code>, then{" "}
                <code className="font-mono">cheat TeleportToPlayer</code>.
            </p>

            {acting?.dialog === "history" && target && (
                <ArkHistoryDialog
                    installedAppId={installedAppId}
                    player={target.name}
                    steamId={target.steamId}
                    onClose={() => setActing(null)}
                />
            )}

            {acting?.dialog === "player" && (
                <ArkPlayerDialog
                    player={target ? { steamId: target.steamId, label: target.name } : null}
                    pending={pending}
                    error={dialogError}
                    onClose={() => setActing(null)}
                    onLookUp={(query) => actions.findArkPlayerByUserAction(installedAppId, query)}
                    onSave={(input) =>
                        runInDialog(
                            () =>
                                actions.addArkPlayerAction(
                                    installedAppId,
                                    input.steamId,
                                    input.label
                                ),
                            target ? undefined : "Added. The server is told as soon as it answers."
                        )
                    }
                />
            )}
            {acting?.dialog === "message" && target && (
                <ArkMessageDialog
                    name={target.name}
                    pending={pending}
                    error={dialogError}
                    onClose={() => setActing(null)}
                    onSend={(message) =>
                        runInDialog(
                            () =>
                                actions.messageArkPlayerAction(
                                    installedAppId,
                                    target.steamId,
                                    message
                                ),
                            `Sent to ${target.name}.`
                        )
                    }
                />
            )}
            {acting?.dialog === "give" && target && (
                <ArkGiveDialog
                    name={target.name}
                    pending={pending}
                    error={dialogError}
                    recent={recentItems}
                    onClose={() => setActing(null)}
                    onGive={(input) => {
                        // In front of the list before the server has been asked,
                        // so the next give opens on what was just handed out.
                        setRecentItems((was) =>
                            [input.key, ...was.filter((id) => id !== input.key)].slice(0, 12)
                        );
                        runOptimistic(
                            () =>
                                actions.giveArkItemAction({
                                    installedAppId,
                                    steamId: target.steamId,
                                    ...input
                                }),
                            // Said rather than claimed: the server takes the
                            // command and answers nothing either way, so the note
                            // is about what was sent.
                            `Sent ${input.quantity} to ${target.name}. ARK does not confirm a give - ask them to look.`,
                            (reason) => `${target.name} was not given anything: ${reason}`
                        );
                    }}
                />
            )}
            {acting?.dialog === "experience" && target && (
                <ArkExperienceDialog
                    name={target.name}
                    pending={pending}
                    error={dialogError}
                    onClose={() => setActing(null)}
                    onGive={(amount) =>
                        runOptimistic(
                            () =>
                                actions.giveArkExperienceAction(
                                    installedAppId,
                                    target.steamId,
                                    amount
                                ),
                            `Sent ${amount} experience to ${target.name}.`,
                            (reason) => `${target.name} was given no experience: ${reason}`
                        )
                    }
                />
            )}
            {acting?.dialog === "timeout" && target && (
                <PlayerTimeoutDialog
                    player={target.name}
                    pending={pending}
                    error={dialogError}
                    onClose={() => setActing(null)}
                    onTimeout={(minutes, reason) =>
                        runInDialog(
                            () =>
                                actions.timeoutArkPlayerAction({
                                    installedAppId,
                                    steamId: target.steamId,
                                    minutes,
                                    reason
                                }),
                            `${target.name} is out for a while.`
                        )
                    }
                />
            )}

            {confirmElement}
        </div>
    );
}

/**
 * Say something to everyone who is playing.
 *
 * The one thing an operator needs before every restart and the only way to say it
 * without being in the game: a restart nobody was warned about costs whatever
 * everyone was carrying. It sits above the table because the people it reaches are
 * the rows underneath it.
 */
function Broadcast({ installedAppId, answering }: { installedAppId: string; answering: boolean }) {
    const [message, setMessage] = useState("");
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function send(): void {
        setError(null);
        setNote(null);
        startTransition(async () => {
            const result = await actions.broadcastArkAction(installedAppId, message.trim());
            if (result.error) {
                setError(result.error);
                return;
            }
            setMessage("");
            setNote("Sent to everyone playing.");
        });
    }

    return (
        <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    className="min-w-56 flex-1"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        if (message.trim().length > 0 && answering) send();
                    }}
                    placeholder="Say something to everyone: restarting in 5 minutes"
                    aria-label="Say something to everyone playing"
                    disabled={!answering}
                />
                <Button
                    onClick={send}
                    disabled={pending || !answering || message.trim().length === 0}
                >
                    {pending ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <Megaphone className="size-4" />
                    )}
                    Send
                </Button>
            </div>
            <span className={cn("text-xs", error ? "text-danger" : "text-muted-foreground")}>
                {error ??
                    note ??
                    (answering ? "Appears in everyone's chat." : "The server is not answering.")}
            </span>
        </div>
    );
}

/**
 * One person, in whatever states they are in, with the verbs that apply to them.
 *
 * Drawn in the same language as the Minecraft rows, because they are the same
 * table: the name and its second line, a badge for what they are doing, a wrap of
 * badges for where they stand, the verbs an operator reaches for as icons, and the
 * rest behind a menu. What a state is called differs; how it reads should not.
 */
function ArkPlayerRow({
    entry,
    live: read,
    canModerate,
    canManage,
    answering,
    pending,
    timeout,
    profile,
    seen,
    admin,
    onAdmin,
    onAllow,
    onRemove,
    onEdit,
    onHistory,
    onMessage,
    onGive,
    onExperience,
    onKill,
    onStrip,
    onKick,
    onBan,
    onUnban,
    onTimeout
}: {
    entry: ArkPlayerEntry;
    /** Whether the server has been asked yet who is on it. Before that nobody is
     *  offline - they are simply not known about, and a grey "Offline" against a
     *  name that is playing is worse than saying nothing. */
    live: boolean;
    canModerate: boolean;
    /** Whether they may hand out the heavier of the two grants. Making somebody an
     *  admin is not moderation - an admin can spawn and destroy anything. */
    canManage: boolean;
    answering: boolean;
    pending: boolean;
    /** The timeout they are serving, when they are serving one. The only ban this
     *  screen can know about: ARK's own list cannot be read back. */
    timeout: PlayerTimeout | null;
    /** What their own survivor file says, or null for somebody who has never
     *  played here - and for every row while the server is down. */
    profile: ArkProfile | null;
    /** When Polaris last saw them on, or null for somebody it never has. */
    seen: PlayerSeen | null;
    /** Whether they are on the server's admin list. */
    admin: boolean;
    onAdmin: (admin: boolean) => void;
    onAllow: () => void;
    onRemove: () => void;
    onEdit: () => void;
    onHistory: () => void;
    onMessage: () => void;
    onGive: () => void;
    onExperience: () => void;
    onKill: () => void;
    onStrip: () => void;
    onKick: () => void;
    onBan: () => void;
    onUnban: () => void;
    onTimeout: () => void;
}) {
    // Every verb that reaches the game needs a server that is answering. Editing
    // the list is Polaris' own and does not.
    const live = answering && !pending;
    // What the line under the badge says - see `presenceLine`, which is where the
    // three cases are settled and tested.
    const line = presenceLine({ online: entry.online, seen, addedAt: entry.addedAt });

    return (
        <tr
            className={cn(
                "border-t border-border hover:bg-card-hover",
                // Somebody the server will not let in is still worth showing and is
                // not what anybody is scanning for.
                entry.standing === "not-allowed" && !entry.online && "opacity-60"
            )}
        >
            <td className="px-3 py-2">
                <p className="flex items-center gap-1.5 truncate font-medium" title={entry.name}>
                    {/* The same mark the Minecraft table puts against an operator,
                        because it is the same thing: somebody who may do anything
                        on this server. */}
                    {admin && <Crown className="size-3.5 text-warning" role="img" aria-label="Admin" />}
                    {entry.name}
                </p>
                {/* The name they gave their survivor, when it is not the Steam name
                    the list came back with - a moderator recognises one of the two
                    and it is not always the same one. */}
                {profile?.characterName && profile.characterName !== entry.name && (
                    <span className="block truncate text-xs text-muted-foreground">
                        Plays as {profile.characterName}
                    </span>
                )}
                <span className="block truncate text-xs text-muted-foreground md:hidden">
                    {entry.steamId}
                </span>
            </td>
            {/* Out of the survivor's own file rather than out of the game: ARK has
                no command that answers it, and a player who has never joined has no
                file to read. */}
            <td className="px-3 py-2 tabular-nums">
                {profile?.level == null ? (
                    <span
                        className="text-muted-foreground"
                        title="Read from the survivor's own file: a server that is off cannot be asked, and somebody who has never played here has no file yet."
                    >
                        -
                    </span>
                ) : (
                    profile.level
                )}
            </td>
            <td className="hidden px-3 py-2 md:table-cell">
                <div className="flex items-center gap-1">
                    <code className="font-mono text-xs text-muted-foreground">{entry.steamId}</code>
                    <CopyButton value={entry.steamId} label={`the Steam id of ${entry.name}`} />
                </div>
            </td>
            {/* Badge and a smaller line under it, the shape the Minecraft table
                uses - and now saying the same thing it does: when they were last
                on. ARK itself cannot answer that (it reports who is connected this
                second and nothing about a minute ago), so it comes from Polaris's
                own record of who it has watched. Only somebody Polaris has never
                seen play falls back to when the row was added, which is a fact
                about the list rather than about the person. */}
            <td className="px-3 py-2">
                <div className="flex flex-col items-start gap-0.5">
                    {!read ? (
                        <Skeleton className="h-5 w-16" />
                    ) : entry.online ? (
                        <Badge variant="success">{playerPresence.playing}</Badge>
                    ) : (
                        <Badge>{playerPresence.offline}</Badge>
                    )}
                    {/* The whole history is a click away wherever there is one,
                        the way it is on the Minecraft table: what somebody asks
                        after "last on yesterday" is "how often". */}
                    {line?.kind === "added" ? (
                        <span
                            className="text-xs text-muted-foreground"
                            title="Polaris has not watched them play here yet."
                        >
                            Added <RelativeTime iso={line.iso} />
                        </span>
                    ) : (
                        line && (
                            <button
                                type="button"
                                onClick={onHistory}
                                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                                title={`When ${entry.name} joined and left`}
                            >
                                {line.kind === "since" ? "Playing since " : "Last on "}
                                <RelativeTime iso={line.iso} />
                            </button>
                        )
                    )}
                </div>
            </td>
            <td className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-1">
                    {entry.standing === "allowed" && <Badge variant="primary">{playerStanding.allowed}</Badge>}
                    {entry.standing === "waiting" && (
                        <Badge title="Recorded here. The server is told as soon as it answers.">
                            <Clock className="size-3" /> {playerStanding.waiting}
                        </Badge>
                    )}
                    {entry.standing === "not-allowed" && (
                        <Badge variant="warning">{playerStanding.notAllowed}</Badge>
                    )}
                    {admin && (
                        <Badge title="May run admin commands in game without the password. In force from the server's next start.">
                            {playerStanding.operator}
                        </Badge>
                    )}
                    {/* The only ban this screen can be sure of. ARK keeps its ban
                        list to itself, so a permanent one leaves nothing to show;
                        a timeout is Polaris' own note and says when it lifts. */}
                    {timeout && (
                        <Badge variant="danger" title={`Lifts ${new Date(timeout.until).toLocaleString()}`}>
                            <Timer className="size-3" />
                            timed out, {timeoutRemaining(timeout.until)}
                        </Badge>
                    )}
                </div>
            </td>
            <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                    {canModerate &&
                        (entry.standing === "not-allowed" ? (
                            <PlayerIconAction
                                label={playerAction.allow(entry.name)}
                                icon={<UserPlus className="size-4" />}
                                disabled={pending}
                                onClick={onAllow}
                            />
                        ) : (
                            <PlayerIconAction
                                label={playerAction.remove(entry.name)}
                                icon={<UserMinus className="size-4" />}
                                disabled={pending}
                                onClick={onRemove}
                            />
                        ))}
                    {canModerate && entry.online && (
                        <PlayerIconAction
                            label={playerAction.kick(entry.name)}
                            icon={<DoorOpen className="size-4" />}
                            disabled={!live}
                            onClick={onKick}
                        />
                    )}
                    {/* Whichever of the two applies: somebody serving a timeout is
                        already banned, and the verb they need is the one that ends
                        it - the same swap the Minecraft row makes. */}
                    {canModerate &&
                        (timeout ? (
                            <PlayerIconAction
                                label={playerAction.pardon(entry.name)}
                                icon={<UserPlus className="size-4" />}
                                disabled={!live}
                                onClick={onUnban}
                            />
                        ) : (
                            <PlayerIconAction
                                label={playerAction.ban(entry.name)}
                                icon={<Ban className="size-4" />}
                                disabled={!live}
                                danger
                                onClick={onBan}
                            />
                        ))}
                    {canModerate && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={playerAction.more(entry.name)}
                                    title="More"
                                >
                                    <MoreHorizontal className="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>{entry.name}</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem disabled={pending} onSelect={onEdit}>
                                    <Pencil className="size-4" /> {playerMenuItem.edit}
                                </DropdownMenuItem>
                                {/* ARK's nearest thing to an operator. Listing
                                    somebody here lets them run admin commands
                                    without being told the password - which is the
                                    only way to take it back from one person
                                    without changing it for everybody. Offered to
                                    whoever may manage the server, not to every
                                    moderator, and it is the file that is written:
                                    the game reads it when it starts. */}
                                {canManage && (
                                    <DropdownMenuItem
                                        disabled={pending}
                                        onSelect={() => onAdmin(!admin)}
                                    >
                                        {admin ? (
                                            <ShieldMinus className="size-4" />
                                        ) : (
                                            <ShieldPlus className="size-4" />
                                        )}
                                        {admin ? "Stop them administering it" : "Let them administer it"}
                                    </DropdownMenuItem>
                                )}
                                {/* The id is a number, and the question behind it
                                    is always "who is this" - which only Steam can
                                    answer. Opening it here is the difference
                                    between a moderator deciding and guessing. */}
                                <DropdownMenuItem asChild>
                                    <a
                                        href={`https://steamcommunity.com/profiles/${entry.steamId}`}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                    >
                                        <Eye className="size-4" /> Open their Steam profile
                                    </a>
                                </DropdownMenuItem>
                                {/* Kept whether or not they are on: how much
                                    somebody has played is exactly the question
                                    asked about a name that is not there. */}
                                <DropdownMenuItem onSelect={onHistory}>
                                    <Clock className="size-4" /> Their history
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    disabled={!live || !entry.online}
                                    onSelect={onMessage}
                                >
                                    <MessageSquare className="size-4" /> {playerMenuItem.message}
                                </DropdownMenuItem>
                                {/* Only while they are on. Unlike Minecraft, where
                                    a give to somebody asleep is written down and
                                    handed over when they join, ARK puts the item
                                    into a character that has to be loaded in the
                                    world - so an offline give would be a command
                                    the server takes and drops. */}
                                <DropdownMenuItem
                                    disabled={!live || !entry.online}
                                    onSelect={onGive}
                                >
                                    <PackagePlus className="size-4" /> Give them something
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    disabled={!live || !entry.online}
                                    onSelect={onExperience}
                                >
                                    <Sparkles className="size-4" /> Give them experience
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                {/* The two that act on the survivor rather than on
                                    the account. Both need the number the game knows
                                    them by, which is read out of their own file -
                                    so both refuse, with a reason, for somebody who
                                    has never played here. */}
                                <DropdownMenuItem
                                    className="text-danger"
                                    disabled={!live || !entry.online}
                                    onSelect={onKill}
                                >
                                    <Skull className="size-4" /> Kill their survivor
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    className="text-danger"
                                    disabled={!live || !entry.online}
                                    onSelect={onStrip}
                                >
                                    <PackageMinus className="size-4" /> Empty their inventory
                                </DropdownMenuItem>
                                {/* Offered to anybody, because ARK does not say who
                                    is banned: the ban list is the server's own and
                                    nothing reads it back, so the only honest thing
                                    is to let it be lifted for whoever it was. */}
                                <DropdownMenuItem disabled={!live} onSelect={onUnban}>
                                    <UserPlus className="size-4" /> {playerMenuItem.pardon}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                {/* A ban with an end. ARK has no such command - this
                                    is its own ban plus a note Polaris comes back to
                                    lift - which is why it is offered here and not
                                    against somebody already serving one. */}
                                <DropdownMenuItem
                                    className="text-danger"
                                    disabled={!live || timeout !== null}
                                    onSelect={onTimeout}
                                >
                                    <Timer className="size-4" /> {playerMenuItem.timeout}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                </div>
            </td>
        </tr>
    );
}

/** What the server writes down about itself. Who may join is not here: that
 *  switch sits above the list it decides, on the Players screen. */
function ClosedServerCard({
    installedAppId,
    access,
    canManage,
    onChanged
}: {
    installedAppId: string;
    access: ArkAccessView | null;
    canManage: boolean;
    onChanged: () => void;
}) {
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function run(work: () => Promise<{ error?: string }>): void {
        setError(null);
        startTransition(async () => {
            const result = await work();
            if (result.error) {
                setError(result.error);
                return;
            }
            onChanged();
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm font-medium">What the server records</p>
                {error && <p className="text-sm text-danger">{error}</p>}
                <label className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
                    <span className="flex flex-col gap-0.5 text-sm">
                        <span className="font-medium">Record what happens in the game</span>
                        <span className="text-xs text-muted-foreground">
                            The chat, and the admin commands somebody ran. ARK keeps none of it
                            otherwise, so a command the server declined leaves nothing to read.
                            Under Files, in server/ShooterGame/Saved/Logs.
                        </span>
                    </span>
                    <Switch
                        checked={access?.logging ?? false}
                        onChange={(on) =>
                            run(() => actions.setArkGameLogAction(installedAppId, on))
                        }
                        disabled={!canManage || pending || access === null}
                        aria-label="Record what happens in the game"
                    />
                </label>
            </CardBody>
        </Card>
    );
}

function PasswordCard({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    canManage: boolean;
}) {
    const [shown, setShown] = useState<{
        joinPassword: string | null;
        adminPassword: string | null;
    } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function reveal(): void {
        setError(null);
        startTransition(async () => {
            const result = await actions.revealArkPasswordsAction(installedAppId);
            if (result.error) {
                setError(result.error);
                return;
            }
            setShown({
                joinPassword: result.joinPassword ?? null,
                adminPassword: result.adminPassword ?? null
            });
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm font-medium">Passwords</p>
                <p className="text-sm text-muted-foreground">
                    The join password is what players type to get in. The admin password is what you
                    type after enablecheats in game, and Polaris minted it when the server was
                    created - it is not a default anybody else knows. ARK takes neither of them
                    longer than 32 characters.
                </p>

                {error && <p className="text-sm text-danger">{error}</p>}

                {shown ? (
                    <dl className="flex flex-col gap-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                            <dt className="text-muted-foreground">Join password</dt>
                            <dd className="flex items-center gap-1">
                                <code className="font-mono">{shown.joinPassword ?? "-"}</code>
                                {shown.joinPassword && (
                                    <CopyButton
                                        value={shown.joinPassword}
                                        label="the join password"
                                    />
                                )}
                            </dd>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                            <dt className="text-muted-foreground">Admin password</dt>
                            <dd className="flex items-center gap-1">
                                <code className="font-mono">{shown.adminPassword ?? "-"}</code>
                                {shown.adminPassword && (
                                    <CopyButton
                                        value={shown.adminPassword}
                                        label="the admin password"
                                    />
                                )}
                            </dd>
                        </div>
                    </dl>
                ) : (
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={reveal}
                        disabled={pending}
                        className="w-fit"
                    >
                        {pending ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Eye className="size-4" />
                        )}
                        Show the passwords
                    </Button>
                )}

                {canManage && (
                    <>
                        <ChangePassword
                            label="New join password"
                            help="Players type this. Applied the next time the server starts."
                            save={(value) =>
                                actions.setArkJoinPasswordAction(installedAppId, value)
                            }
                            onSaved={() => setShown(null)}
                        />
                        <ChangePassword
                            label="New admin password"
                            help="Typed after enablecheats in game. Applied the next time the server starts."
                            save={(value) =>
                                actions.setArkAdminPasswordAction(installedAppId, value)
                            }
                            onSaved={() => setShown(null)}
                        />
                    </>
                )}
            </CardBody>
        </Card>
    );
}

/** One password field and the button that saves it. Both of a server's passwords
 *  are changed the same way and refused on the same rule, so they are one control
 *  used twice rather than two that could drift apart. */
function ChangePassword({
    label,
    help,
    save,
    onSaved
}: {
    label: string;
    help: string;
    save: (value: string) => Promise<{ error?: string }>;
    onSaved: () => void;
}) {
    const [value, setValue] = useState("");
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const invalid = value.length > 0 && !isJoinPassword(value);

    function submit(): void {
        setError(null);
        setMessage(null);
        startTransition(async () => {
            const result = await save(value.trim());
            if (result.error) {
                setError(result.error);
                return;
            }
            setValue("");
            onSaved();
            setMessage("Saved. It takes effect the next time the server starts.");
        });
    }

    return (
        // The button sits in the same row as the field it saves, not at the bottom
        // of the whole block: the hint underneath is a third line, and aligning to
        // the end of that left the button floating below the input it belongs to.
        <div className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">{label}</span>
            <div className="flex flex-wrap items-center gap-2">
                <div className="flex min-w-56 flex-1 items-center gap-1">
                    <Input
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        className="font-mono"
                        placeholder="8 to 32 letters and digits"
                        aria-label={label}
                    />
                    <Button
                        size="icon"
                        variant="ghost"
                        onClick={() =>
                            setValue(
                                generateJoinPassword((size) =>
                                    crypto.getRandomValues(new Uint8Array(size))
                                )
                            )
                        }
                        aria-label={`Generate a password for ${label.toLowerCase()}`}
                        title="Generate one"
                    >
                        <RefreshCw className="size-4" />
                    </Button>
                </div>
                <Button onClick={submit} disabled={pending || !isJoinPassword(value)}>
                    {pending && <Loader2 className="size-4 animate-spin" />}
                    Change
                </Button>
            </div>
            <span
                className={cn(
                    "text-xs",
                    error || invalid ? "text-danger" : "text-muted-foreground"
                )}
            >
                {error ?? (invalid ? JOIN_PASSWORD_HINT : (message ?? help))}
            </span>
        </div>
    );
}
