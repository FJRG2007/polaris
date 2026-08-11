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
import { findArkMap } from "@/lib/apps/ark/maps";
import type { GameContext } from "./game-context";
import { MinecraftAccess } from "./minecraft-access";
import { MinecraftDomain } from "./minecraft-domain";
import { CopyButton } from "@/components/copy-button";
import { usePathname, useRouter } from "next/navigation";
import { MinecraftSettings } from "./minecraft-settings";
import type { InstalledAppSetting } from "@/lib/apps/install-service";
import type { ArkAccessView, ArkStatus } from "@/lib/apps/ark/service";
import type { GameReachAdvice } from "@/lib/apps/minecraft/reach-advice";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { canOpenGameTab, gameTabHref, isGameTab, visibleGameTabs } from "./tabs";
import { CONSUMPTION_METRICS, MetricsHistory } from "@/components/metrics-history";
import { generateJoinPassword, isJoinPassword, isSteamId, JOIN_PASSWORD_HINT } from "@/lib/apps/ark/access";
import { Badge, Button, Card, CardBody, Input, Skeleton, Switch, cn } from "@polaris/ui";
import { Clock, Eye, FolderOpen, Loader2, RefreshCw, Save, ShieldAlert, Trash2, UserPlus } from "lucide-react";
import {
    addArkPlayerAction,
    removeArkPlayerAction,
    revealArkPasswordsAction,
    saveArkWorldAction,
    setArkAdminPasswordAction,
    setArkExclusiveJoinAction,
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
                onOpenAccess={() => openTab("security")}
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
                    status={status}
                    access={reading.access}
                    canModerate={held.includes("games.moderate")}
                    onOpenAccess={() => openTab("security")}
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
                    <AllowListCard
                        installedAppId={installedAppId}
                        access={reading.access}
                        canModerate={held.includes("games.moderate")}
                        canManage={held.includes("games.manage")}
                        onChanged={(next) => setReading((current) => ({ ...current, access: next }))}
                        onReload={() => void load()}
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
                <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs text-muted-foreground">Server address</span>
                    {status === null ? (
                        <Skeleton className="h-7 w-48" />
                    ) : address ? (
                        <div className="flex items-center gap-2">
                            <code className="truncate font-mono text-lg" title={address}>
                                {address}
                            </code>
                            <CopyButton value={address} label="Copy the server address" />
                        </div>
                    ) : (
                        <span className="text-sm text-muted-foreground">
                            Not published yet - the address appears once the server has deployed.
                        </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                        {[findArkMap(map)?.label ?? map, session].filter(Boolean).join(" - ")}
                    </span>
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

function PlayersTab({
    status,
    access,
    canModerate,
    onOpenAccess
}: {
    status: ArkStatus | null;
    access: ArkAccessView | null;
    canModerate: boolean;
    onOpenAccess: () => void;
}) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">Playing now</p>
                    {canModerate && (
                        <Button size="sm" variant="secondary" onClick={onOpenAccess}>
                            <UserPlus className="size-4" /> Who may join
                        </Button>
                    )}
                </div>
                {status === null ? (
                    <Skeleton className="h-16 w-full" />
                ) : !status.answering ? (
                    <p className="text-sm text-muted-foreground">{status.message ?? "The server is not answering."}</p>
                ) : status.players.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Nobody is playing right now.</p>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="py-1 font-medium">Player</th>
                                <th className="py-1 font-medium">Steam id</th>
                                <th className="py-1 font-medium">On the list</th>
                            </tr>
                        </thead>
                        <tbody>
                            {status.players.map((player) => {
                                const allowed = access?.players.some((entry) => entry.steamId === player.steamId);
                                return (
                                    <tr key={player.steamId} className="border-t border-border">
                                        <td className="py-1.5">{player.name}</td>
                                        <td className="py-1.5">
                                            <div className="flex items-center gap-1">
                                                <code className="font-mono text-xs">{player.steamId}</code>
                                                <CopyButton
                                                    value={player.steamId}
                                                    label={`the Steam id of ${player.name}`}
                                                />
                                            </div>
                                        </td>
                                        <td className="py-1.5 text-xs text-muted-foreground">
                                            {allowed ? "Yes" : "No"}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </CardBody>
        </Card>
    );
}

/** Who the server lets in, and whether it has been told. */
function AllowListCard({
    installedAppId,
    access,
    canModerate,
    canManage,
    onChanged,
    onReload
}: {
    installedAppId: string;
    access: ArkAccessView | null;
    canModerate: boolean;
    canManage: boolean;
    onChanged: (access: ArkAccessView) => void;
    onReload: () => void;
}) {
    const [steamId, setSteamId] = useState("");
    const [label, setLabel] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [closing, setClosing] = useState(false);

    const steamIdError = steamId.trim().length === 0 || isSteamId(steamId) ? null : "17 digits, starting 7656119";

    function add(): void {
        setError(null);
        startTransition(async () => {
            const result = await addArkPlayerAction(installedAppId, steamId.trim(), label.trim());
            if (result.error || !result.access) {
                setError(result.error ?? "Could not add that player");
                return;
            }
            setSteamId("");
            setLabel("");
            onChanged(result.access);
        });
    }

    function remove(id: string): void {
        setError(null);
        startTransition(async () => {
            const result = await removeArkPlayerAction(installedAppId, id);
            if (result.error || !result.access) {
                setError(result.error ?? "Could not remove that player");
                return;
            }
            onChanged(result.access);
        });
    }

    function setClosed(closed: boolean): void {
        setError(null);
        setClosing(true);
        startTransition(async () => {
            const result = await setArkExclusiveJoinAction(installedAppId, closed);
            setClosing(false);
            if (result.error) {
                setError(result.error);
                return;
            }
            onReload();
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm font-medium">Who may join</p>

                <label className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
                    <span className="flex flex-col gap-0.5 text-sm">
                        <span className="font-medium">Only players on this list can join</span>
                        <span className="text-xs text-muted-foreground">
                            On top of the join password. Off leaves the password as the only lock, and takes effect the
                            next time the server starts.
                        </span>
                    </span>
                    <Switch
                        checked={access?.closed ?? false}
                        onChange={setClosed}
                        disabled={!canManage || pending || closing || access === null}
                        aria-label="Only players on this list can join"
                    />
                </label>

                {error && <p className="text-sm text-danger">{error}</p>}

                {access === null ? (
                    <Skeleton className="h-16 w-full" />
                ) : access.players.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Nobody is on the list.</p>
                ) : (
                    <ul className="flex flex-col gap-1">
                        {access.players.map((player) => (
                            <li
                                key={player.steamId}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                            >
                                <div className="flex min-w-0 flex-col">
                                    <span className="truncate text-sm" title={player.label}>{player.label}</span>
                                    <code className="font-mono text-xs text-muted-foreground">{player.steamId}</code>
                                </div>
                                <div className="flex items-center gap-2">
                                    {player.appliedAt === null ? (
                                        <span
                                            className="flex items-center gap-1 text-xs text-muted-foreground"
                                            title="Recorded here. The server is told as soon as it answers."
                                        >
                                            <Clock className="size-3.5" /> Waiting for the server
                                        </span>
                                    ) : (
                                        <Badge className="border-success/40 text-success">On the server</Badge>
                                    )}
                                    {canModerate && (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            disabled={pending}
                                            onClick={() => remove(player.steamId)}
                                            aria-label={`Remove ${player.label}`}
                                            title={`Remove ${player.label}`}
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}

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
                            {steamIdError && <span className="text-xs text-danger">{steamIdError}</span>}
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
                            <UserPlus className="size-4" /> Add
                        </Button>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}

/** The two passwords the server runs on: the one players type, and the one the
 *  owner types into the game. Neither rides on the poll - they are fetched when
 *  somebody asks for them, and only the owner may. */
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
