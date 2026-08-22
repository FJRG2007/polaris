"use client";

/**
 * The Minecraft server's own dashboard inside Polaris: where to connect, who is
 * playing, the console, moderation and the settings - built from Polaris
 * components, so an installed app looks like part of the product rather than
 * something embedded in it.
 *
 * The overview paints immediately from what the page already knows (its name, its
 * settings, whether it is meant to be running) and fills the live parts in as the
 * server answers, because a server that is still generating a world can take a
 * minute to say anything at all.
 *
 * Each screen is a real path (`.../console`), so reloading while reading the
 * console lands back on the console rather than on the overview. Switching writes
 * the URL through the history API rather than navigating, because the panel holds
 * a live poll of the server: a navigation would tear it down and every screen
 * would open on skeletons it already had the answers for.
 */

import Link from "next/link";
import { GameConsole } from "./game-console";
import type { Permission } from "@polaris/core";
import { MinecraftMods } from "./minecraft-mods";
import type { GameContext } from "./game-context";
import { MinecraftRules } from "./minecraft-rules";
import { MinecraftReset } from "./minecraft-reset";
import { MinecraftWorld } from "./minecraft-world";
import { findMap } from "@/lib/apps/minecraft/maps";
import { MinecraftAccess } from "./minecraft-access";
import { MinecraftDomain } from "./minecraft-domain";
import { isConfigCrash } from "@/lib/apps/crash-loop";
import { CopyButton } from "@/components/copy-button";
import { usePathname, useRouter } from "next/navigation";
import { MinecraftSettings } from "./minecraft-settings";
import { MinecraftAppearance } from "./minecraft-appearance";
import type { QueuedAction } from "@/lib/apps/minecraft/queue";
import type { ServerPresence } from "@/lib/apps/games-service";
import type { PlayerTimeout } from "@/lib/apps/player-timeout";
import { useGamePresence } from "@/components/use-game-presence";
import { MinecraftSchedule, NO_SCHEDULE } from "./minecraft-schedule";
import type { InstalledAppSetting } from "@/lib/apps/install-service";
import { FirewallSection, MinecraftPlayers } from "./minecraft-players";
import type { PlayerSeen } from "@/lib/apps/games-activity";
import type { PlayerSessionEvent } from "@/lib/apps/minecraft/sessions";
import type { GameReachAdvice } from "@/lib/apps/minecraft/reach-advice";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, CardBody, Skeleton, cn } from "@polaris/ui";
import type { PlayerAccessView } from "@/lib/apps/minecraft/player-access";
import { findBlueprint, hasCrossplay } from "@/lib/apps/minecraft/blueprints";
import { resetServerConfigAction, saveWorldAction } from "./minecraft-actions";
import { FolderOpen, Loader2, Save, ShieldAlert, UserPlus } from "lucide-react";
import { canOpenGameTab, gameTabHref, isGameTab, visibleGameTabs } from "./tabs";
import { CONSUMPTION_METRICS, MetricsHistory, PLAYER_METRICS } from "@/components/metrics-history";
import type { MinecraftFirewall, MinecraftRoster, MinecraftStatus } from "@/lib/apps/minecraft/service";

/** Mods are managed on their own screen, so their variables are not repeated as
 *  raw fields on Settings. */
const MODS_GROUP = "Mods";

/** The setting that lists what the image installs, which is also where the answer
 *  to "do Bedrock clients join this one" is written. */
const PROJECTS_KEY = "MODRINTH_PROJECTS";

/** The description has an editor of its own - a preview, a colour toolbar and the
 *  centring - so it is not also offered as a raw text field two cards below, where
 *  the two would quietly disagree about what the server is running on. */
const MOTD_KEY = "MOTD";

/** Who may do what, on its own screen: an operator looking for the setting that
 *  keeps griefers out should not have to scroll past the render distance. */
const SECURITY_GROUP = "Security";

/**
 * How long after one read finishes before the next one starts.
 *
 * Unhurried, because the thing that changes by itself is not read here any more.
 * Who is playing arrives on the live stream within a couple of seconds of it
 * happening; what this poll is for - the roster, the machine, whether the port
 * answers from outside - moves slowly, and every one of those reads is a command
 * inside the container.
 */
const POLL_MS = 12000;

/** How old a streamed reading may be before the screen stops preferring it to what
 *  the poll last returned. Several times the stream's own cadence, so a frame that
 *  is merely between beats is still trusted, and a connection that has silently
 *  died is not. */
const PRESENCE_STALE_MS = 25000;

interface ServerReading {
    status: MinecraftStatus | null;
    /** What is still in the way of players outside this network, as of the last
     *  poll: the operator forwards the port with this page open, so the answer has
     *  to arrive without a reload. Null until the first poll answers. */
    reach: GameReachAdvice | null;
    roster: MinecraftRoster | null;
    firewall: MinecraftFirewall | null;
    access: PlayerAccessView | null;
    /** Who arrived and who left, as far back as the log reaches. */
    sessions: readonly PlayerSessionEvent[];
    /** When Polaris last watched each of them, for the rows the log has scrolled
     *  past. Keyed as `seenFor` looks them up. */
    seen: Readonly<Record<string, PlayerSeen>>;
    /** The server's clock when it read them, so the browser's own being out does
     *  not change what a player is reported as doing. */
    now: number;
    /** Bans with an end, and when each one lifts. */
    timeouts: readonly PlayerTimeout[];
    /** What experience level each player who is on right now has reached. Only the
     *  moderation screen asks for it, and only Java can answer. */
    levels: Readonly<Record<string, number>>;
    /** Decisions the server could not be told yet. */
    pending: readonly QueuedAction[];
}

export function MinecraftPanel({
    installedAppId,
    applicationId,
    name,
    settings,
    running,
    game,
    held,
    onStatus
}: {
    installedAppId: string;
    applicationId: string | null;
    /** What Polaris calls it, which the appearance panel renames and the MOTD
     *  preview draws above the description. */
    name: string;
    settings: InstalledAppSetting[];
    running: boolean;
    /** The server's address, and what still has to be opened for players outside
     *  this network. */
    game: GameContext | null;
    /** What the viewer holds on this server. Decides which screens are offered;
     *  the route refuses the rest by URL, and each action asks again. */
    held: readonly Permission[];
    /** Told what the server is actually doing, so the page has one answer rather
     *  than a header that reports what Polaris intends and a card beneath it
     *  reporting what the container is up to. */
    onStatus?: (label: string | null) => void;
}) {
    const router = useRouter();
    const pathname = usePathname();
    // The screen the URL names. Read from the path rather than held in state, so a
    // reload, a shared link and the browser's back button all agree with the tabs.
    const tab = useMemo(() => {
        const base = `/apps/installed/${installedAppId}`;
        const slug = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, "") : "";
        // A screen this viewer does not hold falls back to the overview rather than
        // rendering empty. The route already refuses it; this is what keeps a
        // history entry from an earlier, wider grant from landing on nothing.
        return isGameTab(slug, "minecraft") && canOpenGameTab(slug, held, "minecraft") ? slug : "";
    }, [pathname, installedAppId, held]);
    const tabs = useMemo(() => visibleGameTabs(held, "minecraft"), [held]);
    const openTab = useCallback(
        (slug: string) => {
            if (slug === tab) return;
            window.history.pushState(null, "", gameTabHref(installedAppId, slug));
        },
        [installedAppId, tab]
    );
    // Seeded with what the page already knew, so the list of who may join is on
    // screen before a request goes out. Only what the server itself has to answer -
    // who is playing, the roster, the log - waits on the poll.
    const [reading, setReading] = useState<ServerReading>({
        status: null,
        reach: null,
        roster: null,
        firewall: null,
        access: game?.playerAccess ?? null,
        sessions: [],
        seen: {},
        now: Date.now(),
        timeouts: [],
        levels: {},
        pending: []
    });
    const [error, setError] = useState<string | null>(null);
    /** What Polaris last said it intends the server to do, so the page can re-read
     *  itself when that changes underneath it. */
    const intended = useRef(running);

    // The roster costs three reads inside the container, so it is only gathered
    // for the screen that shows it.
    const wantsRoster = tab === "players" || tab === "security";

    const load = useCallback(async () => {
        try {
            const response = await fetch(
                `/api/apps/installed/${installedAppId}/minecraft${wantsRoster ? "?roster=1" : ""}`,
                { cache: "no-store" }
            );
            const data = (await response.json()) as {
                status?: MinecraftStatus;
                reach?: GameReachAdvice | null;
                roster?: MinecraftRoster;
                firewall?: MinecraftFirewall;
                access?: PlayerAccessView;
                sessions?: PlayerSessionEvent[];
                seen?: Record<string, PlayerSeen>;
                timeouts?: PlayerTimeout[];
                levels?: Record<string, number>;
                pending?: QueuedAction[];
                now?: string;
                error?: string;
            };
            if (!response.ok || !data.status) {
                setError(data.error ?? "Could not read the server");
                return;
            }
            setError(null);
            setReading((current) => ({
                status: data.status ?? null,
                // Kept when a poll could not work it out, rather than dropped back
                // to the page's: the warning would flicker on every failed read.
                reach: data.reach ?? current.reach,
                roster: data.roster ?? (wantsRoster ? current.roster : null),
                firewall: data.firewall ?? (wantsRoster ? current.firewall : null),
                // Read on every poll, not only the moderation screen's, because the
                // overview says whether anybody can join at all.
                access: data.access ?? current.access,
                // Checked rather than taken: these two are read by walking them,
                // and a payload that answered with the wrong shape took the whole
                // screen down instead of one panel.
                sessions: Array.isArray(data.sessions)
                    ? data.sessions
                    : wantsRoster
                      ? current.sessions
                      : [],
                // Kept between polls of the same screen, like the levels beside
                // it: a read the server was too busy to answer would otherwise
                // blank the line under every row.
                seen: data.seen ?? (wantsRoster ? current.seen : {}),
                timeouts: Array.isArray(data.timeouts)
                    ? data.timeouts
                    : wantsRoster
                      ? current.timeouts
                      : [],
                pending: Array.isArray(data.pending)
                    ? data.pending
                    : wantsRoster
                      ? current.pending
                      : [],
                // Kept between polls of the same screen so the column does not
                // blink empty on a read the server was too busy to answer.
                levels: data.levels ?? (wantsRoster ? current.levels : {}),
                now: data.now ? Date.parse(data.now) : current.now
            }));
            // The header's Start and Stop, and everything else the page rendered on
            // the server, come from the install row. A poll that finds the server in
            // the other state is that row having gone stale - after a start, a stop,
            // or a schedule that fired while somebody was looking at the screen -
            // and without this the only way back was reloading by hand.
            if (data.status.running !== intended.current) {
                intended.current = data.status.running;
                router.refresh();
            }
        } catch {
            // Transient; the next poll retries.
        }
    }, [installedAppId, wantsRoster, router]);

    // Scheduled from the end of a read rather than on a fixed interval: a read runs
    // a command inside the container, and a slow one would otherwise have polls
    // stacking up behind each other.
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
                streamed && Date.now() - presence.at < PRESENCE_STALE_MS ? streamed : null
            ),
        [reading.status, streamed, presence.at]
    );
    // What the poll knows beats what the page was rendered with: the second is a
    // snapshot from whenever it was opened, and reading them together is how a
    // server that had just been started kept saying it was stopped.
    const isRunning = status?.running ?? running;

    // The shell draws the badge in the header; only this component polls, so it is
    // the one that knows.
    useEffect(() => {
        onStatus?.(statusLabel(status, isRunning));
    }, [onStatus, status, isRunning]);

    /** Settings come from the page, so applying them has to re-render it -
     *  otherwise the form keeps showing the old values as the current ones. */
    const reloadSettings = useCallback(() => {
        router.refresh();
        void load();
    }, [router, load]);

    return (
        <div className="flex flex-col gap-4">
            <ConnectCard
                status={status}
                running={isRunning}
                settings={settings}
                installedAppId={installedAppId}
                applicationId={applicationId}
                reach={reading.reach}
                access={reading.access}
                canSaveWorld={held.includes("games.moderate")}
                onOpenPlayers={() => openTab("players")}
                onOpenConsole={() => openTab("console")}
            />

            {error && <p className="text-sm text-danger">{error}</p>}

            <nav className="no-scrollbar flex items-center gap-1 overflow-x-auto border-b border-border/60 text-sm">
                {tabs.map((entry) => (
                    // A real href, so a screen can be middle-clicked, opened in a
                    // new tab and copied; the plain click is taken over to keep the
                    // panel's poll alive across the switch.
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

            {tab === "" && (
                <OverviewTab
                    status={status}
                    settings={settings}
                    blueprintId={game?.blueprintId ?? null}
                    mapId={game?.mapId ?? null}
                    onOpenPlayers={() => openTab("players")}
                />
            )}
            {tab === "console" && (
                <GameConsole
                    installedAppId={installedAppId}
                    applicationId={applicationId}
                    running={isRunning}
                    game={status?.edition === "bedrock" ? "bedrock" : "java"}
                    players={[...(status?.players.players ?? [])]}
                />
            )}
            {tab === "players" && (
                <MinecraftPlayers
                    installedAppId={installedAppId}
                    status={status}
                    roster={reading.roster}
                    access={reading.access}
                    sessions={reading.sessions}
                    seen={reading.seen}
                    now={reading.now}
                    timeouts={reading.timeouts}
                    levels={reading.levels}
                    pending={reading.pending}
                    onChanged={() => void load()}
                />
            )}
            {tab === "world" && <MinecraftWorld installedAppId={installedAppId} name={name} />}
            {tab === "rules" && (
                <MinecraftRules installedAppId={installedAppId} canManage={held.includes("games.manage")} />
            )}
            {tab === "access" && <MinecraftAccess installedAppId={installedAppId} />}
            {tab === "usage" &&
                (applicationId ? (
                    // The same history Deploy draws for any service, because a game
                    // server is one: it is already sampled and already stored, and a
                    // second copy of it under another name would be a second thing
                    // to keep true.
                    <div className="space-y-4">
                        {/* Above the machine's numbers, because it is the one
                            somebody opens this tab for: what the server cost is
                            only interesting next to how many people it carried. */}
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

            {tab === "mods" && (
                <MinecraftMods
                    installedAppId={installedAppId}
                    settings={settings}
                    playersOnline={status?.players.online ?? 0}
                    onSaved={reloadSettings}
                />
            )}
            {tab === "security" && (
                <div className="flex flex-col gap-4">
                    <MinecraftSettings
                        installedAppId={installedAppId}
                        settings={settings.filter((setting) => setting.group === SECURITY_GROUP)}
                        playersOnline={status?.players.online ?? 0}
                        running={isRunning}
                        onSaved={reloadSettings}
                    />
                    {/* The firewall guards HTTP and a game server is not HTTP, so
                        its addresses only mean anything here once they are on the
                        server's own ban list. That is a security question, and it
                        used to sit at the bottom of the players table. */}
                    <FirewallSection
                        installedAppId={installedAppId}
                        firewall={reading.firewall}
                        onError={setError}
                        onChanged={() => void load()}
                    />
                </div>
            )}

            {tab === "settings" && (
                <div className="flex flex-col gap-4">
                    <MinecraftAppearance
                        installedAppId={installedAppId}
                        name={name}
                        motd={settings.find((setting) => setting.key === MOTD_KEY)?.value ?? ""}
                        iconSetAt={game?.iconSetAt ?? null}
                        playersOnline={status?.players.online ?? 0}
                        onSaved={reloadSettings}
                    />
                    <MinecraftSchedule
                        runs={game?.routineRuns ?? null}
                        installedAppId={installedAppId}
                        state={game?.scheduleState ?? null}
                        schedule={game?.schedule ?? NO_SCHEDULE}
                    />
                    <MinecraftDomain
                        installedAppId={installedAppId}
                        hostname={game?.hostname ?? null}
                        suffix={game?.suffix ?? null}
                        address={status?.address ?? null}
                        routed={game?.routed ?? false}
                        canRoute={game?.canRoute ?? false}
                    />
                    <MinecraftSettings
                        installedAppId={installedAppId}
                        settings={settings.filter(
                            (setting) =>
                                setting.group !== MODS_GROUP &&
                                setting.group !== SECURITY_GROUP &&
                                setting.key !== MOTD_KEY
                        )}
                        playersOnline={status?.players.online ?? 0}
                        running={isRunning}
                        onSaved={reloadSettings}
                    />
                    <MinecraftReset
                        installedAppId={installedAppId}
                        edition={game?.edition ?? "java"}
                        blueprintId={game?.blueprintId ?? null}
                        mapId={game?.mapId ?? null}
                        crossplay={hasCrossplay(
                            settings.find((setting) => setting.key === PROJECTS_KEY)?.value
                        )}
                        playersOnline={status?.players.online ?? 0}
                        onDone={reloadSettings}
                    />
                </div>
            )}
        </div>
    );
}

/** The address players type into their client - the first thing anyone opening
 *  this page came for - plus what the server is doing right now. */
function ConnectCard({
    status,
    running,
    settings,
    installedAppId,
    applicationId,
    reach,
    access,
    canSaveWorld,
    onOpenPlayers,
    onOpenConsole
}: {
    status: MinecraftStatus | null;
    running: boolean;
    settings: InstalledAppSetting[];
    installedAppId: string;
    applicationId: string | null;
    reach: GameReachAdvice | null;
    /** Who may connect. Null until the first poll answers. */
    access: PlayerAccessView | null;
    /** Flushing the world writes to it, so it is the moderator grant rather than
     *  something every reader is offered. */
    canSaveWorld: boolean;
    onOpenPlayers: () => void;
    onOpenConsole: () => void;
}) {
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState<string | null>(null);
    const [fixing, setFixing] = useState(false);
    const [fixed, setFixed] = useState<string | null>(null);
    const software = settings.find((setting) => setting.key === "TYPE");
    const version = settings.find((setting) => setting.key === "VERSION");
    const softwareLabel = software?.options?.find((option) => option.value === software.value)?.label ?? software?.value;

    /**
     * Move the settings the server cannot read out of the way, and start it.
     *
     * The whole of the fix for this one crash: there is nothing to repair in the
     * game, only a folder written by a release this server no longer runs, and it
     * writes its own again on the next boot. Nothing is deleted.
     */
    async function resetConfig(): Promise<void> {
        setFixing(true);
        setFixed(null);
        const result = await resetServerConfigAction(installedAppId);
        setFixing(false);
        setFixed(
            result.error ??
                (result.moved
                    ? "The old settings were moved beside the world and the server is starting."
                    : "There was nothing left to move. The server is starting.")
        );
    }

    async function saveWorld(): Promise<void> {
        setSaving(true);
        const result = await saveWorldAction(installedAppId);
        setSaving(false);
        setSaved(result.error ?? "World saved");
    }

    return (
        <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs text-muted-foreground">Server address</span>
                    {status === null ? (
                        <Skeleton className="h-7 w-48" />
                    ) : status.address ? (
                        <div className="flex items-center gap-2">
                            <code className="truncate font-mono text-lg" title={status.address}>{status.address}</code>
                            <CopyButton value={status.address} label="Copy the server address" />
                        </div>
                    ) : (
                        <span className="text-sm text-muted-foreground">
                            Not published yet - the address appears once the server has deployed.
                        </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                        {[softwareLabel, version?.value].filter(Boolean).join(" - ")}
                    </span>
                </div>

                <div className="flex items-center gap-3">
                    <StatusBadge status={status} running={running} />
                    {applicationId && (
                        // The world, the configs and the plugin folders, in the same
                        // explorer every other file in Polaris is browsed from.
                        <Link href={`/drive?c=container:${applicationId}&p=/data`}>
                            <Button size="sm" variant="secondary" title="Browse this server's files in Drive">
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
                            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                            Save world
                        </Button>
                    )}
                </div>
                {saved && <p className="w-full text-xs text-muted-foreground">{saved}</p>}

                {/* The state that used to be invisible. A server that cannot start
                    restarts forever and reports "starting" the whole time, which
                    is the same word a server three minutes into its first boot
                    reports - so this is above everything else on the card, because
                    nothing else on it is true while this is. */}
                {status?.crashLoop && (
                    <div className="flex w-full items-start gap-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2">
                        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" />
                        <div className="flex flex-col items-start gap-1 text-xs">
                            <p className="font-medium text-foreground">This server keeps failing to start</p>
                            <p className="text-muted-foreground">
                                It restarted {status.crashLoop.restarts} times without starting, so it has been
                                stopped.
                            </p>
                            {status.crashLoop.cause && (
                                <p className="font-mono text-muted-foreground">{status.crashLoop.cause}</p>
                            )}
                            {status.crashLoop.advice && (
                                <p className="text-muted-foreground">{status.crashLoop.advice}</p>
                            )}
                            <div className="flex items-center gap-3">
                                {/* Only offered for the crash where it is the
                                    answer. On any other one it would be a button
                                    that throws away settings and changes nothing. */}
                                {isConfigCrash(status.crashLoop.cause) && (
                                    <button
                                        type="button"
                                        onClick={() => void resetConfig()}
                                        disabled={fixing}
                                        className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-60"
                                    >
                                        {fixing && <Loader2 className="size-3 animate-spin" />}
                                        Reset the settings and start it
                                    </button>
                                )}
                                <button type="button" onClick={onOpenConsole} className="text-primary hover:underline">
                                    Read the console
                                </button>
                            </div>
                            {fixed && <p className="text-muted-foreground">{fixed}</p>}
                        </div>
                    </div>
                )}

                {/* An address nobody is allowed to use is not an address. Both
                    images boot with their list enforced and empty, so this is the
                    state a brand-new server is in, and the operator standing here
                    with the address copied is exactly who has to be told. */}
                {access !== null && access.rules.length === 0 && (
                    <div className="flex w-full items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
                        <UserPlus className="mt-0.5 size-4 shrink-0 text-warning" />
                        <div className="flex flex-col items-start gap-1 text-xs">
                            <p className="font-medium text-foreground">Nobody can join yet</p>
                            <p className="text-muted-foreground">
                                No player is registered, so the server refuses everyone - including you. Add your{" "}
                                {access.edition === "bedrock" ? "gamertag" : "Minecraft username"} and the address you
                                play from, then connect on the address above.
                            </p>
                            <button
                                type="button"
                                onClick={onOpenPlayers}
                                className="text-primary hover:underline"
                            >
                                Add yourself in Players
                            </button>
                        </div>
                    </div>
                )}

                {/* The address is only an address if packets can get to it. A game
                    port rides on nothing the domain setup opened, so this is where
                    an operator finds out - not from a friend timing out. */}
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
                                <Link href="/admin/domains#game-ports" className="w-fit text-primary hover:underline">
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

/**
 * The reading the screen shows: what the poll last returned, with the streamed
 * presence laid over it.
 *
 * A frame carries who is on and nothing else - not the roster, not what the
 * machine is costing - so it is laid over the fuller reading rather than replacing
 * it. Before the first poll has answered there is nothing to lay it over: unlike
 * ARK, a Minecraft reading names which edition it is, and that is not something to
 * guess at from a frame.
 */
function withPresence(status: MinecraftStatus | null, presence: ServerPresence | null): MinecraftStatus | null {
    if (!status || !presence) return status;
    return {
        ...status,
        answering: presence.answering,
        containerRunning: presence.containerRunning,
        message: presence.message,
        crashLoop: presence.crashLoop,
        players: {
            online: presence.online,
            max: presence.max || status.players.max,
            players: presence.players.map((player) => player.name)
        }
    };
}

/**
 * What the server is doing, in one word.
 *
 * "Meant to be running" and "running" are different things, and the page used to
 * show both without saying which was which: the header read Running off the
 * desired state while the card under it read Starting off a container that had
 * been dead for an hour. One function decides now, and the header is told.
 */
function statusLabel(status: MinecraftStatus | null, running: boolean): string | null {
    if (status === null) return null;
    // Before either of the two words below, both of which a looping container is
    // momentarily entitled to and neither of which is the useful one.
    if (status.crashLoop) return "Crash loop";
    if (!running || !status.running) return "Stopped";
    if (status.containerRunning === false) return "Not running";
    return status.answering ? "Online" : "Starting";
}

function StatusBadge({ status, running }: { status: MinecraftStatus | null; running: boolean }) {
    const label = statusLabel(status, running);
    if (label === null) return <Skeleton className="h-6 w-20" />;
    if (label === "Crash loop") return <Badge variant="danger">Crash loop</Badge>;
    if (label === "Not running") return <Badge variant="danger">Not running</Badge>;
    if (label === "Starting") return <Badge className="border-warning/40 text-warning">Starting</Badge>;
    if (label === "Stopped") return <Badge>Stopped</Badge>;
    return (
        <Badge className="border-success/40 text-success">
            {status?.players.online} / {status?.players.max} online
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
    settings,
    blueprintId,
    mapId,
    onOpenPlayers
}: {
    status: MinecraftStatus | null;
    settings: InstalledAppSetting[];
    /** What it was built from, so the screen can say what that game still needs. */
    blueprintId: string | null;
    /** The map it is standing on, which is somebody's work and is credited. */
    mapId: string | null;
    onOpenPlayers: () => void;
}) {
    const shown = useMemo(
        () => settings.filter((setting) => ["DIFFICULTY", "MODE", "MAX_PLAYERS", "MEMORY", "MOTD"].includes(setting.key)),
        [settings]
    );
    const blueprint = findBlueprint(blueprintId ?? "");
    const map = findMap(mapId ?? "");
    // A map is the game on the servers that have one, so the blueprint's note
    // about the plugin it replaced would be describing something that is not here.
    const note = map
        ? { title: map.name, text: map.setup, docs: map.source, docsLabel: "Where this map came from" }
        : blueprint?.setup
          ? {
                title: `${blueprint.name}: what is left to do`,
                text: blueprint.setup,
                docs: blueprint.docs,
                docsLabel: "The plugin's own instructions"
            }
          : null;

    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* The honest half of a blueprint. Polaris installs the plugin and
                shapes the world for it; a minigame with no map of its own is still
                a lobby until somebody makes one, and a server that looks like an
                empty world with no explanation reads as a broken install rather
                than as the next step. Full width, because it is the answer to the
                question anybody who just created this is about to ask. */}
            {note && (note.text || map) && (
                <Card className="lg:col-span-2">
                    <CardBody className="flex flex-col gap-2">
                        <p className="text-sm font-medium">{note.title}</p>
                        {map && (
                            <p className="text-sm text-muted-foreground">
                                Built by {map.author}, for Minecraft {map.minecraft.version}.
                            </p>
                        )}
                        {note.text && <p className="text-sm text-muted-foreground">{note.text}</p>}
                        {note.docs && (
                            <a
                                href={note.docs}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="self-start text-sm text-primary underline-offset-2 hover:underline"
                            >
                                {note.docsLabel}
                            </a>
                        )}
                    </CardBody>
                </Card>
            )}
            <Card>
                <CardBody className="flex flex-col gap-3">
                    <p className="text-sm font-medium">Playing now</p>
                    {status === null ? (
                        <Skeleton className="h-8 w-full" />
                    ) : !status.answering ? (
                        <p className="text-sm text-muted-foreground">{status.message ?? "The server is not answering."}</p>
                    ) : status.players.players.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Nobody is playing right now.</p>
                    ) : (
                        <div className="flex flex-wrap gap-1">
                            {status.players.players.map((player) => (
                                <button
                                    key={player}
                                    type="button"
                                    onClick={onOpenPlayers}
                                    title={`Manage ${player}`}
                                    className="rounded-md border border-border px-2 py-1 text-sm transition-colors hover:border-primary/50"
                                >
                                    {player}
                                </button>
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
                                <dd>{status.cpuPercent === null ? "-" : `${status.cpuPercent.toFixed(1)}%`}</dd>
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
                            // A description is the long one here, and clipping it
                            // with nothing carrying the rest hides exactly what an
                            // operator opened the overview to read.
                            const value =
                                setting.options?.find((option) => option.value === setting.value)?.label ??
                                setting.value ??
                                "-";
                            return (
                                <div key={setting.key} className="flex items-baseline justify-between gap-3">
                                    <dt className="text-muted-foreground">{setting.label}</dt>
                                    <dd className="truncate text-right" title={value}>
                                        {value}
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
