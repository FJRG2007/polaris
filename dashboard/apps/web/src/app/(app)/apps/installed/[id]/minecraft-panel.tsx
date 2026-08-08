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
 */

import Link from "next/link";
import type { GameContext } from "./page";
import { useRouter } from "next/navigation";
import { MinecraftMods } from "./minecraft-mods";
import { MinecraftDomain } from "./minecraft-domain";
import { CopyButton } from "@/components/copy-button";
import { saveWorldAction } from "./minecraft-actions";
import { MinecraftConsole } from "./minecraft-console";
import { MinecraftPlayers } from "./minecraft-players";
import { MinecraftSettings } from "./minecraft-settings";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { InstalledAppSetting } from "@/lib/apps/install-service";
import type { GameReachAdvice } from "@/lib/apps/minecraft/reach-advice";
import { Badge, Button, Card, CardBody, Skeleton, cn } from "@polaris/ui";
import type { PlayerAccessView } from "@/lib/apps/minecraft/player-access";
import { FolderOpen, Loader2, Save, ShieldAlert, UserPlus } from "lucide-react";
import type { MinecraftFirewall, MinecraftRoster, MinecraftStatus } from "@/lib/apps/minecraft/service";

const TABS = [
    { id: "overview", label: "Overview" },
    { id: "console", label: "Console" },
    { id: "players", label: "Players" },
    { id: "mods", label: "Mods" },
    { id: "settings", label: "Settings" }
] as const;

/** Mods are managed on their own screen, so their variables are not repeated as
 *  raw fields on Settings. */
const MODS_GROUP = "Mods";

type TabId = (typeof TABS)[number]["id"];

const POLL_MS = 5000;

interface ServerReading {
    status: MinecraftStatus | null;
    /** What is still in the way of players outside this network, as of the last
     *  poll: the operator forwards the port with this page open, so the answer has
     *  to arrive without a reload. Null until the first poll answers. */
    reach: GameReachAdvice | null;
    roster: MinecraftRoster | null;
    firewall: MinecraftFirewall | null;
    access: PlayerAccessView | null;
}

export function MinecraftPanel({
    installedAppId,
    applicationId,
    settings,
    running,
    game
}: {
    installedAppId: string;
    applicationId: string | null;
    settings: InstalledAppSetting[];
    running: boolean;
    /** The server's address, and what still has to be opened for players outside
     *  this network. */
    game: GameContext | null;
}) {
    const router = useRouter();
    const [tab, setTab] = useState<TabId>("overview");
    const [reading, setReading] = useState<ServerReading>({
        status: null,
        reach: null,
        roster: null,
        firewall: null,
        access: null
    });
    const [error, setError] = useState<string | null>(null);

    // The roster costs three reads inside the container, so it is only gathered
    // for the screen that shows it.
    const wantsRoster = tab === "players";

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
                access: data.access ?? current.access
            }));
        } catch {
            // Transient; the next poll retries.
        }
    }, [installedAppId, wantsRoster]);

    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [load]);

    /** Settings come from the page, so applying them has to re-render it -
     *  otherwise the form keeps showing the old values as the current ones. */
    const reloadSettings = useCallback(() => {
        router.refresh();
        void load();
    }, [router, load]);

    const status = reading.status;

    return (
        <div className="flex flex-col gap-4">
            <ConnectCard
                status={status}
                running={running}
                settings={settings}
                installedAppId={installedAppId}
                applicationId={applicationId}
                reach={reading.reach ?? game?.reach ?? null}
                access={reading.access}
                onOpenPlayers={() => setTab("players")}
            />

            {error && <p className="text-sm text-danger">{error}</p>}

            <div className="no-scrollbar flex items-center gap-1 overflow-x-auto border-b border-border/60 text-sm">
                {TABS.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        onClick={() => setTab(entry.id)}
                        className={cn(
                            "-mb-px whitespace-nowrap border-b-2 px-3 py-2 transition-colors",
                            tab === entry.id
                                ? "border-primary text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {entry.label}
                    </button>
                ))}
            </div>

            {tab === "overview" && <OverviewTab status={status} settings={settings} onOpenPlayers={() => setTab("players")} />}
            {tab === "console" && (
                <MinecraftConsole installedAppId={installedAppId} applicationId={applicationId} running={running} />
            )}
            {tab === "players" && (
                <MinecraftPlayers
                    installedAppId={installedAppId}
                    status={status}
                    roster={reading.roster}
                    firewall={reading.firewall}
                    access={reading.access}
                    onChanged={() => void load()}
                />
            )}
            {tab === "mods" && (
                <MinecraftMods
                    installedAppId={installedAppId}
                    settings={settings}
                    playersOnline={status?.players.online ?? 0}
                    onSaved={reloadSettings}
                />
            )}
            {tab === "settings" && (
                <div className="flex flex-col gap-4">
                    <MinecraftDomain
                        installedAppId={installedAppId}
                        hostname={game?.hostname ?? null}
                        suffix={game?.suffix ?? null}
                        address={status?.address ?? null}
                    />
                    <MinecraftSettings
                        installedAppId={installedAppId}
                        settings={settings.filter((setting) => setting.group !== MODS_GROUP)}
                        playersOnline={status?.players.online ?? 0}
                        onSaved={reloadSettings}
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
    onOpenPlayers
}: {
    status: MinecraftStatus | null;
    running: boolean;
    settings: InstalledAppSetting[];
    installedAppId: string;
    applicationId: string | null;
    reach: GameReachAdvice | null;
    /** Who may connect. Null until the first poll answers. */
    access: PlayerAccessView | null;
    onOpenPlayers: () => void;
}) {
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState<string | null>(null);
    const software = settings.find((setting) => setting.key === "TYPE");
    const version = settings.find((setting) => setting.key === "VERSION");
    const softwareLabel = software?.options?.find((option) => option.value === software.value)?.label ?? software?.value;

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
                </div>
                {saved && <p className="w-full text-xs text-muted-foreground">{saved}</p>}

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

function StatusBadge({ status, running }: { status: MinecraftStatus | null; running: boolean }) {
    if (status === null) return <Skeleton className="h-6 w-20" />;
    if (!running || !status.running) return <Badge>Stopped</Badge>;
    if (!status.answering) return <Badge className="border-warning/40 text-warning">Starting</Badge>;
    return (
        <Badge className="border-success/40 text-success">
            {status.players.online} / {status.players.max} online
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
    onOpenPlayers
}: {
    status: MinecraftStatus | null;
    settings: InstalledAppSetting[];
    onOpenPlayers: () => void;
}) {
    const shown = useMemo(
        () => settings.filter((setting) => ["DIFFICULTY", "MODE", "MAX_PLAYERS", "MEMORY", "MOTD"].includes(setting.key)),
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
                        {shown.map((setting) => (
                            <div key={setting.key} className="flex items-baseline justify-between gap-3">
                                <dt className="text-muted-foreground">{setting.label}</dt>
                                <dd className="truncate text-right">
                                    {setting.options?.find((option) => option.value === setting.value)?.label ??
                                        setting.value ??
                                        "-"}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </CardBody>
            </Card>
        </div>
    );
}
