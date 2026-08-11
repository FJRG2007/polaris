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
import { GameConsole } from "./game-console";
import type { Permission } from "@polaris/core";
import { findArkMap, mapRequirementHint } from "@/lib/apps/ark/maps";
import type { GameContext } from "./game-context";
import { MinecraftAccess } from "./minecraft-access";
import { MinecraftDomain } from "./minecraft-domain";
import { MinecraftSchedule, NO_SCHEDULE } from "./minecraft-schedule";
import { CopyButton } from "@/components/copy-button";
import { foldArkPlayers, matchesArkPlayer, type ArkPlayerEntry } from "@/lib/apps/ark/players";
import { PlayerIconAction, PlayersTable } from "@/components/game-players-table";
import { usePathname, useRouter } from "next/navigation";
import { MinecraftSettings } from "./minecraft-settings";
import type { InstalledAppSetting } from "@/lib/apps/install-service";
import type { ArkAccessView, ArkStatus } from "@/lib/apps/ark/service";
import type { GameReachAdvice } from "@/lib/apps/minecraft/reach-advice";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { canOpenGameTab, gameTabHref, isGameTab, visibleGameTabs } from "./tabs";
import { CONSUMPTION_METRICS, MetricsHistory } from "@/components/metrics-history";
import { Badge, Button, Card, CardBody, Input, Skeleton, Switch, cn } from "@polaris/ui";
import { generateJoinPassword, isJoinPassword, isSteamId, JOIN_PASSWORD_HINT } from "@/lib/apps/ark/access";
import { Ban, Clock, DoorOpen, Eye, FolderOpen, Loader2, Megaphone, RefreshCw, Save, ShieldAlert, UserMinus, UserPlus } from "lucide-react";
import {
    addArkPlayerAction,
    broadcastArkAction,
    moderateArkPlayerAction,
    removeArkPlayerAction,
    revealArkPasswordsAction,
    saveArkWorldAction,
    setArkAdminPasswordAction,
    setArkExclusiveJoinAction,
    setArkGameLogAction,
    setArkJoinPasswordAction
} from "./ark-actions";

const POLL_MS = 5000;

/** Managed by the Access screen's own controls rather than offered twice as raw
 *  fields - the two would quietly disagree about what the server is running on. */
const SECURITY_GROUP = "Security";

interface ServerReading {
    status: ArkStatus | null;
    /** What a player types to connect. Worked out from the same read the list
     *  uses, so the two cannot disagree. Null until the first poll answers. */
    address: string | null;
    /** What is still in the way of players outside this network, as of the last
     *  poll. Null until the first one answers. */
    reach: GameReachAdvice | null;
    access: ArkAccessView | null;
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
        const slug = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, "") : "";
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

    const [reading, setReading] = useState<ServerReading>({
        status: null,
        address: null,
        reach: null,
        access: null
    });
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const response = await fetch(`/api/apps/installed/${installedAppId}/ark`, { cache: "no-store" });
            const data = (await response.json()) as {
                status?: ArkStatus;
                address?: string | null;
                reach?: GameReachAdvice | null;
                access?: ArkAccessView | null;
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
                access: data.access ?? current.access
            }));
        } catch {
            // Transient; the next poll retries.
        }
    }, [installedAppId]);

    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [load]);

    useEffect(() => {
        onStatus?.(statusLabel(reading.status, running));
    }, [onStatus, reading.status, running]);

    const reloadSettings = useCallback(() => {
        router.refresh();
        void load();
    }, [router, load]);

    const status = reading.status;

    return (
        <div className="flex flex-col gap-4">
            <ConnectCard
                status={status}
                address={reading.address}
                running={running}
                settings={settings}
                installedAppId={installedAppId}
                applicationId={applicationId}
                reach={reading.reach ?? game?.reach ?? null}
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
                    running={running}
                    logName="ark"
                    hint="ListPlayers, or Broadcast Server restarting in 5"
                />
            )}
            {tab === "players" && (
                <PlayersTab
                    installedAppId={installedAppId}
                    status={status}
                    access={reading.access}
                    canModerate={held.includes("games.moderate")}
                    onChanged={(next) => {
                        if (next) setReading((current) => ({ ...current, access: next }));
                        void load();
                    }}
                />
            )}
            {tab === "usage" &&
                (applicationId ? (
                    <MetricsHistory
                        endpoint={`/api/deploy/apps/${applicationId}/metrics/history`}
                        metrics={CONSUMPTION_METRICS}
                    />
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
                    <PasswordCard installedAppId={installedAppId} canManage={held.includes("games.manage")} />
                    <MinecraftSettings
                        installedAppId={installedAppId}
                        settings={settings.filter((setting) => setting.group === SECURITY_GROUP)}
                        playersOnline={status?.players.length ?? 0}
                        onSaved={reloadSettings}
                    />
                </div>
            )}
            {tab === "access" && <MinecraftAccess installedAppId={installedAppId} />}
            {tab === "settings" && (
                <div className="flex flex-col gap-4">
                    <MinecraftSchedule installedAppId={installedAppId} schedule={game?.schedule ?? NO_SCHEDULE} />
                    <MinecraftDomain
                        installedAppId={installedAppId}
                        hostname={game?.hostname ?? null}
                        suffix={game?.suffix ?? null}
                        address={reading.address}
                    />
                    <MinecraftSettings
                        installedAppId={installedAppId}
                        settings={settings.filter((setting) => setting.group !== SECURITY_GROUP)}
                        playersOnline={status?.players.length ?? 0}
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
        const result = await saveArkWorldAction(installedAppId);
        setSaving(false);
        setSaved(result.error ?? "World saved");
    }

    return (
        <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-2">
                    {status === null ? (
                        <Skeleton className="h-7 w-56" />
                    ) : address === null ? (
                        <span className="text-sm text-muted-foreground">
                            Not published yet - the address appears once the server has deployed.
                        </span>
                    ) : (
                        <>
                            {/* Two addresses, because ARK is joined two ways and each
                                takes a different port. Showing only one was worth an
                                evening: pasted into Steam, the connect address is
                                answered with "server not found", which names neither
                                the port nor the mistake. */}
                            <JoinAddress
                                title="Add in Steam, or the in-game browser"
                                value={withPort(address, status.queryPort)}
                                detail="Steam, View, Servers, Favourites, +. It appears in ARK under Favourites."
                            />
                            <JoinAddress
                                title="Or connect straight to it"
                                value={`open ${withPort(address, status.gamePort)}`}
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
                        <span className="text-xs text-warning">{mapRequirementHint(findArkMap(map))}</span>
                    )}
                </div>

                <div className="flex items-center gap-3">
                    <StatusBadge status={status} running={running} />
                    {applicationId && (
                        <Link href={`/drive?c=container:${applicationId}&p=/app`}>
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

                {/* A server that lets in only the players it was told about, and was
                    never told about anybody, is a server nobody can join - the state
                    a brand-new one is in until it finishes installing. */}
                {access !== null && access.closed && access.players.every((player) => player.appliedAt === null) && (
                    <div className="flex w-full items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
                        <UserPlus className="mt-0.5 size-4 shrink-0 text-warning" />
                        <div className="flex flex-col items-start gap-1 text-xs">
                            <p className="font-medium text-foreground">Nobody can join yet</p>
                            <p className="text-muted-foreground">
                                This server only lets in players it has been told about, and it has not been told about
                                anybody yet - it is still installing. Polaris hands the list over as soon as the server
                                answers; nothing else is needed.
                            </p>
                            <button type="button" onClick={onOpenAccess} className="text-primary hover:underline">
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

/** What the server is doing, in one word. "Meant to be running" and "running" are
 *  different things, and the header is told which. */
function statusLabel(status: ArkStatus | null, running: boolean): string | null {
    if (status === null) return null;
    if (!running || !status.running) return "Stopped";
    if (status.containerRunning === false) return "Not running";
    return status.answering ? "Online" : "Starting";
}

function StatusBadge({ status, running }: { status: ArkStatus | null; running: boolean }) {
    const label = statusLabel(status, running);
    if (label === null) return <Skeleton className="h-6 w-20" />;
    if (label === "Not running") return <Badge variant="danger">Not running</Badge>;
    if (label === "Starting") return <Badge className="border-warning/40 text-warning">Starting</Badge>;
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

function OverviewTab({ status, settings }: { status: ArkStatus | null; settings: InstalledAppSetting[] }) {
    const shown = useMemo(
        () =>
            settings.filter((setting) =>
                ["SERVER_MAP", "SESSION_NAME", "MAX_PLAYERS", "GAME_MOD_IDS", "ENABLE_CROSSPLAY"].includes(setting.key)
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
                        <p className="text-sm text-muted-foreground">Nobody is playing right now.</p>
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
                            const value =
                                setting.options?.find((option) => option.value === setting.value)?.label ??
                                setting.value ??
                                "-";
                            return (
                                <div key={setting.key} className="flex items-baseline justify-between gap-3">
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
    canModerate,
    onChanged
}: {
    installedAppId: string;
    status: ArkStatus | null;
    access: ArkAccessView | null;
    canModerate: boolean;
    onChanged: (access?: ArkAccessView) => void;
}) {
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState("everyone");
    const [steamId, setSteamId] = useState("");
    const [label, setLabel] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

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
                          : true
                ),
        [players, query, filter]
    );

    function run(work: () => Promise<{ error?: string; access?: ArkAccessView }>, done?: string): void {
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

    function add(): void {
        run(async () => {
            const result = await addArkPlayerAction(installedAppId, steamId.trim(), label.trim());
            if (!result.error) {
                setSteamId("");
                setLabel("");
            }
            return result;
        });
    }

    const answering = status?.answering ?? false;

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                {error && <p className="text-sm text-danger">{error}</p>}
                {note && <p className="text-sm text-muted-foreground">{note}</p>}

                {canModerate && <Broadcast installedAppId={installedAppId} answering={answering} />}

                <PlayersTable
                    columns={[
                        { label: "Player" },
                        { label: "Steam id", className: "hidden md:table-cell" },
                        { label: "Status" },
                        { label: "May join" }
                    ]}
                    search={query}
                    onSearch={setQuery}
                    searchPlaceholder="Search by name or Steam id"
                    filter={filter}
                    onFilter={setFilter}
                    filters={[
                        { value: "everyone", label: "Everyone" },
                        { value: "online", label: "Playing now" },
                        { value: "allowed", label: "On the list" }
                    ]}
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
                            canModerate={canModerate}
                            answering={answering}
                            pending={pending}
                            onAllow={() =>
                                run(() => addArkPlayerAction(installedAppId, entry.steamId, entry.name))
                            }
                            onRemove={() => run(() => removeArkPlayerAction(installedAppId, entry.steamId))}
                            onKick={() =>
                                run(
                                    () => moderateArkPlayerAction(installedAppId, entry.steamId, "kick"),
                                    `${entry.name} was thrown off.`
                                )
                            }
                            onBan={() =>
                                run(
                                    () => moderateArkPlayerAction(installedAppId, entry.steamId, "ban"),
                                    `${entry.name} is banned.`
                                )
                            }
                        />
                    ))}
                />

                {canModerate && (
                    <div className="flex flex-wrap items-end gap-2">
                        <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
                            <span className="text-muted-foreground">Steam id</span>
                            <Input
                                value={steamId}
                                onChange={(event) => setSteamId(event.target.value)}
                                placeholder="76561198000000000"
                                inputMode="numeric"
                            />
                            {steamId.trim().length > 0 && !isSteamId(steamId) && (
                                <span className="text-xs text-danger">17 digits, starting 7656119</span>
                            )}
                        </label>
                        <label className="flex min-w-40 flex-1 flex-col gap-1 text-sm">
                            <span className="text-muted-foreground">Name</span>
                            <Input
                                value={label}
                                onChange={(event) => setLabel(event.target.value)}
                                placeholder="Who this is"
                            />
                        </label>
                        <Button onClick={add} disabled={pending || !isSteamId(steamId)}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            <UserPlus className="size-4" /> Let them in
                        </Button>
                    </div>
                )}

                <p className="text-xs text-muted-foreground">
                    Teleporting to a player is not possible from here: ARK moves players relative to an admin&apos;s own
                    character, and Polaris talks to the server without one. In game, press Tab and use{" "}
                    <code className="font-mono">enablecheats</code>, then{" "}
                    <code className="font-mono">cheat TeleportToPlayer</code>.
                </p>
            </CardBody>
        </Card>
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
            const result = await broadcastArkAction(installedAppId, message.trim());
            if (result.error) {
                setError(result.error);
                return;
            }
            setMessage("");
            setNote("Sent to everyone playing.");
        });
    }

    return (
        <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Say something to everyone</span>
                <Input
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        if (message.trim().length > 0 && answering) send();
                    }}
                    placeholder="Restarting in 5 minutes"
                    disabled={!answering}
                />
                <span className={cn("text-xs", error ? "text-danger" : "text-muted-foreground")}>
                    {error ?? note ?? (answering ? "Appears in everyone's chat." : "The server is not answering.")}
                </span>
            </label>
            <Button onClick={send} disabled={pending || !answering || message.trim().length === 0}>
                {pending && <Loader2 className="size-4 animate-spin" />}
                <Megaphone className="size-4" /> Send
            </Button>
        </div>
    );
}

/**
 * One person, in whatever states they are in, with the verbs that apply to them.
 *
 * Drawn in the same language as the Minecraft rows, because they are the same
 * table: the name and its second line, a badge for what they are doing, a wrap of
 * badges for where they stand, and the verbs as icons at the end. What a state is
 * called differs; how it reads should not.
 */
function ArkPlayerRow({
    entry,
    canModerate,
    answering,
    pending,
    onAllow,
    onRemove,
    onKick,
    onBan
}: {
    entry: ArkPlayerEntry;
    canModerate: boolean;
    answering: boolean;
    pending: boolean;
    onAllow: () => void;
    onRemove: () => void;
    onKick: () => void;
    onBan: () => void;
}) {
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
                <p className="truncate font-medium" title={entry.name}>
                    {entry.name}
                </p>
                <span className="block truncate text-xs text-muted-foreground md:hidden">{entry.steamId}</span>
                {entry.addedAt && (
                    <span className="hidden text-xs text-muted-foreground md:block">
                        Added {new Date(entry.addedAt).toLocaleDateString()}
                    </span>
                )}
            </td>
            <td className="hidden px-3 py-2 md:table-cell">
                <div className="flex items-center gap-1">
                    <code className="font-mono text-xs text-muted-foreground">{entry.steamId}</code>
                    <CopyButton value={entry.steamId} label={`the Steam id of ${entry.name}`} />
                </div>
            </td>
            <td className="px-3 py-2">
                {entry.online ? <Badge variant="success">Playing</Badge> : <Badge>Offline</Badge>}
            </td>
            <td className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-1">
                    {entry.standing === "allowed" && <Badge variant="primary">allowed</Badge>}
                    {entry.standing === "waiting" && (
                        <Badge title="Recorded here. The server is told as soon as it answers.">
                            <Clock className="size-3" /> waiting
                        </Badge>
                    )}
                    {entry.standing === "not-allowed" && <Badge variant="warning">not on the list</Badge>}
                </div>
            </td>
            <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                    {canModerate &&
                        (entry.standing === "not-allowed" ? (
                            <PlayerIconAction
                                label={`Let ${entry.name} in`}
                                icon={<UserPlus className="size-4" />}
                                disabled={pending}
                                onClick={onAllow}
                            />
                        ) : (
                            <PlayerIconAction
                                label={`Take ${entry.name} off the list`}
                                icon={<UserMinus className="size-4" />}
                                disabled={pending}
                                onClick={onRemove}
                            />
                        ))}
                    {canModerate && entry.online && (
                        <PlayerIconAction
                            label={`Throw ${entry.name} off`}
                            icon={<DoorOpen className="size-4" />}
                            disabled={pending || !answering}
                            onClick={onKick}
                        />
                    )}
                    {canModerate && (
                        <PlayerIconAction
                            label={`Ban ${entry.name}`}
                            icon={<Ban className="size-4" />}
                            disabled={pending || !answering}
                            danger
                            onClick={onBan}
                        />
                    )}
                </div>
            </td>
        </tr>
    );
}

/** Whether the server lets in anybody it was not told about. The list itself is on
 *  the Players screen, where the people are. */
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

    function setClosed(closed: boolean): void {
        run(() => setArkExclusiveJoinAction(installedAppId, closed));
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm font-medium">Who may join</p>
                {error && <p className="text-sm text-danger">{error}</p>}
                <label className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
                    <span className="flex flex-col gap-0.5 text-sm">
                        <span className="font-medium">Only players on the list can join</span>
                        <span className="text-xs text-muted-foreground">
                            On top of the join password. Off leaves the password as the only lock, and takes effect the
                            next time the server starts. The list itself is on the Players screen.
                        </span>
                    </span>
                    <Switch
                        checked={access?.closed ?? false}
                        onChange={setClosed}
                        disabled={!canManage || pending || access === null}
                        aria-label="Only players on the list can join"
                    />
                </label>
                <label className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
                    <span className="flex flex-col gap-0.5 text-sm">
                        <span className="font-medium">Record what happens in the game</span>
                        <span className="text-xs text-muted-foreground">
                            The chat, and the admin commands somebody ran. ARK keeps none of it otherwise, so a command
                            the server declined leaves nothing to read. Under Files, in
                            server/ShooterGame/Saved/Logs.
                        </span>
                    </span>
                    <Switch
                        checked={access?.logging ?? false}
                        onChange={(on) => run(() => setArkGameLogAction(installedAppId, on))}
                        disabled={!canManage || pending || access === null}
                        aria-label="Record what happens in the game"
                    />
                </label>
            </CardBody>
        </Card>
    );
}

function PasswordCard({ installedAppId, canManage }: { installedAppId: string; canManage: boolean }) {
    const [shown, setShown] = useState<{ joinPassword: string | null; adminPassword: string | null } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function reveal(): void {
        setError(null);
        startTransition(async () => {
            const result = await revealArkPasswordsAction(installedAppId);
            if (result.error) {
                setError(result.error);
                return;
            }
            setShown({ joinPassword: result.joinPassword ?? null, adminPassword: result.adminPassword ?? null });
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm font-medium">Passwords</p>
                <p className="text-sm text-muted-foreground">
                    The join password is what players type to get in. The admin password is what you type after
                    enablecheats in game, and Polaris minted it when the server was created - it is not a default
                    anybody else knows. ARK takes neither of them longer than 32 characters.
                </p>

                {error && <p className="text-sm text-danger">{error}</p>}

                {shown ? (
                    <dl className="flex flex-col gap-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                            <dt className="text-muted-foreground">Join password</dt>
                            <dd className="flex items-center gap-1">
                                <code className="font-mono">{shown.joinPassword ?? "-"}</code>
                                {shown.joinPassword && (
                                    <CopyButton value={shown.joinPassword} label="the join password" />
                                )}
                            </dd>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                            <dt className="text-muted-foreground">Admin password</dt>
                            <dd className="flex items-center gap-1">
                                <code className="font-mono">{shown.adminPassword ?? "-"}</code>
                                {shown.adminPassword && (
                                    <CopyButton value={shown.adminPassword} label="the admin password" />
                                )}
                            </dd>
                        </div>
                    </dl>
                ) : (
                    <Button size="sm" variant="secondary" onClick={reveal} disabled={pending} className="w-fit">
                        {pending ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
                        Show the passwords
                    </Button>
                )}

                {canManage && (
                    <>
                        <ChangePassword
                            label="New join password"
                            help="Players type this. Applied the next time the server starts."
                            save={(value) => setArkJoinPasswordAction(installedAppId, value)}
                            onSaved={() => setShown(null)}
                        />
                        <ChangePassword
                            label="New admin password"
                            help="Typed after enablecheats in game. Applied the next time the server starts."
                            save={(value) => setArkAdminPasswordAction(installedAppId, value)}
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
        <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm">
                <span className="text-muted-foreground">{label}</span>
                <div className="flex items-center gap-1">
                    <Input
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        className="font-mono"
                        placeholder="8 to 32 letters and digits"
                    />
                    <Button
                        size="icon"
                        variant="ghost"
                        onClick={() =>
                            setValue(generateJoinPassword((size) => crypto.getRandomValues(new Uint8Array(size))))
                        }
                        aria-label={`Generate a password for ${label.toLowerCase()}`}
                        title="Generate one"
                    >
                        <RefreshCw className="size-4" />
                    </Button>
                </div>
                <span className={cn("text-xs", error || invalid ? "text-danger" : "text-muted-foreground")}>
                    {error ?? (invalid ? JOIN_PASSWORD_HINT : (message ?? help))}
                </span>
            </label>
            <Button onClick={submit} disabled={pending || !isJoinPassword(value)}>
                {pending && <Loader2 className="size-4 animate-spin" />}
                Change
            </Button>
        </div>
    );
}
