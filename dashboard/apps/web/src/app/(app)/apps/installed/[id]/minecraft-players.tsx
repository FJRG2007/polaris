"use client";

/**
 * Everyone this server knows about, as one table.
 *
 * A player is not five different things, but the game keeps them in five lists -
 * who is on, who is registered here, who is an operator, who is whitelisted, who
 * is banned - and a card per list means reading all five to answer "what is going
 * on with this person", then acting in whichever one happens to hold the verb. So
 * the lists are folded into one row per name carrying every state it is in, and
 * the cuts an operator actually reaches for are a filter over that.
 *
 * Every action is one RCON command and takes effect in the running game, so the
 * server stays the record: the table is re-read from it afterwards. What the row
 * shows in the meantime is the change the operator just made, held until the next
 * read agrees and rolled back if the server refuses - a crown that only appears
 * five seconds later reads as a button that did nothing, and gets pressed twice.
 */

import * as actions from "./minecraft-actions";
import { useConfirm } from "@/components/confirm-dialog";
import { GameAccessForm } from "@/components/game-access-form";
import type { MinecraftModeration } from "./minecraft-actions";
import { ACCESS_REACH_NOTE } from "@/lib/apps/minecraft/access";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { PlayerSessionEvent } from "@/lib/apps/minecraft/sessions";
import type { PlayerAccessView } from "@/lib/apps/minecraft/player-access";
import { foldPlayers, type PlayerEntry } from "@/lib/apps/minecraft/players";
import { timeoutFor, type PlayerTimeout } from "@/lib/apps/minecraft/timeout";
import { describeQueued, waitingOn, type QueuedAction } from "@/lib/apps/minecraft/queue";
import type { MinecraftFirewall, MinecraftRoster, MinecraftStatus } from "@/lib/apps/minecraft/service";
import {
    GiveItemDialog,
    HistoryDialog,
    InventoryDialog,
    LocationDialog,
    TeleportDialog,
    TimeoutDialog,
    type PlayerDialog
} from "./minecraft-player-dialogs";
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
    Select,
    Switch,
    cn
} from "@polaris/ui";
import {
    Backpack,
    Ban,
    Clock,
    Crown,
    DoorOpen,
    History,
    LocateFixed,
    MapPin,
    MoreHorizontal,
    PackagePlus,
    Search,
    ShieldBan,
    ShieldMinus,
    ShieldPlus,
    Skull,
    Timer,
    UserMinus,
    UserPlus,
    Users,
    X
} from "lucide-react";

/** The cuts an operator reaches for; anything finer is what search is for. */
const FILTERS = [
    { value: "all", label: "Everyone" },
    { value: "online", label: "Online" },
    { value: "allowed", label: "Allowed in" },
    { value: "operators", label: "Operators" },
    { value: "banned", label: "Banned" }
] as const;

type Filter = (typeof FILTERS)[number]["value"];

export function MinecraftPlayers({
    installedAppId,
    status,
    roster,
    access,
    sessions,
    now,
    timeouts,
    pending: waiting,
    onChanged
}: {
    installedAppId: string;
    status: MinecraftStatus | null;
    roster: MinecraftRoster | null;
    /** Who may connect and from where - the list the server is actually closed by. */
    access: PlayerAccessView | null;
    /** Who arrived and who left, out of the server's log. */
    sessions: readonly PlayerSessionEvent[];
    /** The server's clock when it read them. */
    now: number;
    /** Bans with an end, and when each one lifts. */
    timeouts: readonly PlayerTimeout[];
    /** Decisions the server could not be told yet, oldest first. */
    pending: readonly QueuedAction[];
    onChanged: () => void;
}) {
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [confirm, confirmElement] = useConfirm();
    // What the operator has just changed, shown until the server's own answer
    // catches up. Keyed by the same lowercase name the lists are folded on.
    const [applied, setApplied] = useState<Map<string, Partial<PlayerEntry>>>(new Map());
    // The player a form is open about, and which form.
    const [acting, setActing] = useState<{ player: PlayerEntry; dialog: PlayerDialog } | null>(null);

    const answering = status?.answering ?? false;
    const bedrock = status?.edition === "bedrock";
    const edition = access?.edition ?? status?.edition ?? "java";
    const known = useMemo(
        () => foldPlayers(status, roster, access, sessions, now),
        [status, roster, access, sessions, now]
    );
    const players = useMemo(
        () => known.map((player) => ({ ...player, ...(applied.get(player.name.toLowerCase()) ?? {}) })),
        [known, applied]
    );
    const registered = access?.rules.length ?? 0;
    const onlineNames = useMemo(
        () => players.filter((player) => player.online).map((player) => player.name),
        [players]
    );

    // An expectation stops being one the moment the server reports the same
    // thing. Dropping it then rather than on a timer means the row never flickers
    // back to the old value and never keeps a stale one after a change elsewhere.
    useEffect(() => {
        setApplied((current) => {
            if (current.size === 0) return current;
            const next = new Map(current);
            for (const player of known) {
                const expectation = next.get(player.name.toLowerCase());
                if (!expectation) continue;
                const agreed = Object.entries(expectation).every(
                    ([field, value]) => player[field as keyof PlayerEntry] === value
                );
                if (agreed) next.delete(player.name.toLowerCase());
            }
            return next.size === current.size ? current : next;
        });
    }, [known]);

    /** Show a change now, and put it back if the server refuses it. */
    function expect(player: string, patch: Partial<PlayerEntry>): () => void {
        const key = player.toLowerCase();
        setApplied((current) => new Map(current).set(key, { ...current.get(key), ...patch }));
        return () =>
            setApplied((current) => {
                const next = new Map(current);
                next.delete(key);
                return next;
            });
    }

    const shown = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return players.filter((player) => {
            if (filter === "online" && !player.online) return false;
            if (filter === "allowed" && player.addresses.length === 0) return false;
            if (filter === "operators" && !player.operator) return false;
            if (filter === "banned" && !player.banned) return false;
            if (!needle) return true;
            return [player.name, ...player.addresses, player.note]
                .filter((value): value is string => Boolean(value))
                .some((value) => value.toLowerCase().includes(needle));
        });
    }, [players, query, filter]);

    function run(action: () => Promise<{ error?: string }>, rollback?: () => void): void {
        setError(null);
        startTransition(async () => {
            const result = await action();
            if (result.error) {
                rollback?.();
                setError(result.error);
                return;
            }
            onChanged();
        });
    }

    /** What each verb will have done to the row, so it can say so at once. The
     *  ones that only take effect in the running world - killing somebody,
     *  handing them an item - change nothing this table shows, so they expect
     *  nothing. */
    function expectationOf(action: MinecraftModeration["action"]): Partial<PlayerEntry> | null {
        switch (action) {
            case "op":
                return { operator: true };
            case "deop":
                return { operator: false };
            case "ban":
                return { banned: true };
            case "pardon":
                return { banned: false, banReason: null };
            case "whitelist-add":
                return { whitelisted: true };
            case "whitelist-remove":
                return { whitelisted: false };
            case "kick":
                return { online: false, presence: "offline" };
            default:
                return null;
        }
    }

    function moderate(input: Omit<MinecraftModeration, "installedAppId">): void {
        const expectation = expectationOf(input.action);
        const rollback = expectation ? expect(input.player, expectation) : undefined;
        run(() => actions.moderatePlayerAction({ ...input, installedAppId }), rollback);
    }

    async function moderateWithConfirm(
        input: Omit<MinecraftModeration, "installedAppId">,
        title: string,
        description: string
    ): Promise<void> {
        if (!(await confirm({ title, description, confirmLabel: "Confirm", danger: true }))) return;
        moderate(input);
    }

    async function addPlayer(input: { username: string; address: string }): Promise<boolean> {
        setError(null);
        const result = await actions.grantPlayerAccessAction({ installedAppId, ...input });
        if (result.error) {
            setError(result.error);
            return false;
        }
        onChanged();
        return true;
    }

    return (
        <div className="flex flex-col gap-4">
            {error && <p className="text-sm text-danger">{error}</p>}

            {/* A server with an empty list is one nobody on earth can join, and
                nothing anywhere saying why. It is also the state a server lands in
                when its first player was removed, so it is worth naming loudly. */}
            {access !== null && registered === 0 && (
                <Card className="border-warning/40 bg-warning/5">
                    <CardBody className="flex flex-col gap-1">
                        <p className="flex items-center gap-2 text-sm font-medium">
                            <Users className="size-4 text-warning" />
                            Nobody can join yet
                        </p>
                        <p className="text-sm text-muted-foreground">
                            The server is closed until somebody is registered. Add yourself first: your{" "}
                            {edition === "bedrock" ? "gamertag" : "Minecraft username"}, and the address you play from -
                            the locate button fills in the one you are on now.
                        </p>
                    </CardBody>
                </Card>
            )}

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <p className="text-sm font-medium">Add a player</p>
                            <p className="text-xs text-muted-foreground">
                                A player is let in when the username is on this list and they arrive from the address
                                registered to it. {ACCESS_REACH_NOTE}
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                                {access?.bindAddresses ? "Address checked" : "Address not checked"}
                            </span>
                            <Switch
                                checked={access?.bindAddresses ?? true}
                                onChange={(enabled) => run(() => actions.setAddressBindingAction(installedAppId, enabled))}
                                disabled={pending || access === null || !access.addressesAvailable}
                                aria-label="Check each player's address when they join"
                            />
                        </div>
                    </div>
                    <GameAccessForm edition={edition} disabled={pending} onAdd={addPlayer} />
                    {access && !access.addressesAvailable && (
                        <p className="text-xs text-muted-foreground">
                            Bedrock does not record where a player connected from, so only the names here are enforced.
                        </p>
                    )}
                </CardBody>
            </Card>

            {waiting.length > 0 && (
                <Card>
                    <CardBody className="flex flex-col gap-2">
                        <div>
                            <p className="text-sm font-medium">Waiting to happen</p>
                            <p className="text-xs text-muted-foreground">
                                Decided while the server or the player was away. Each one runs by itself as soon as it
                                can, and lapses if it never can.
                            </p>
                        </div>
                        <ul className="flex flex-col divide-y divide-border/60">
                            {waiting.map((entry) => (
                                <li key={entry.id} className="flex items-center justify-between gap-3 py-2">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm">
                                            {entry.username}: {describeQueued(entry)}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {entry.lastError ?? waitingOn(entry)} - lapses{" "}
                                            {new Date(entry.expiresAt).toLocaleDateString()}
                                        </p>
                                    </div>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        disabled={pending}
                                        aria-label={`Cancel ${describeQueued(entry)} for ${entry.username}`}
                                        title={`Cancel ${describeQueued(entry)} for ${entry.username}`}
                                        onClick={() =>
                                            startTransition(async () => {
                                                const result = await actions.cancelQueuedActionAction(
                                                    installedAppId,
                                                    entry.id
                                                );
                                                if (result.error) {
                                                    setError(result.error);
                                                    return;
                                                }
                                                onChanged();
                                            })
                                        }
                                    >
                                        <X className="size-4" />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    </CardBody>
                </Card>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        className="pl-9"
                        placeholder="Search by name, address or note"
                        aria-label="Search players"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </div>
                <Select
                    className="sm:w-44"
                    aria-label="Filter players"
                    value={filter}
                    onValueChange={(value) => setFilter(value as Filter)}
                    options={FILTERS.map((entry) => ({ value: entry.value, label: entry.label }))}
                />
                {!bedrock && (
                    <WhitelistSwitch
                        installedAppId={installedAppId}
                        enforced={roster?.whitelistEnforced ?? false}
                        disabled={roster === null || !answering}
                        onError={setError}
                        onChanged={onChanged}
                    />
                )}
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[40rem] text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">Player</th>
                            <th className="px-3 py-2 font-medium">Status</th>
                            <th className="px-3 py-2 font-medium">Standing</th>
                            <th className="hidden px-3 py-2 font-medium md:table-cell">Address</th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {!answering && players.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                                    {status?.message ?? "Connecting to the server..."}
                                </td>
                            </tr>
                        ) : shown.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                                    {players.length === 0
                                        ? "Nobody is registered and nobody is playing."
                                        : "Nobody matches that."}
                                </td>
                            </tr>
                        ) : (
                            shown.map((player) => (
                                <PlayerRow
                                    key={player.name.toLowerCase()}
                                    player={player}
                                    bedrock={bedrock}
                                    answering={answering}
                                    pending={pending}
                                    onModerate={moderate}
                                    onModerateWithConfirm={moderateWithConfirm}
                                    timeout={timeoutFor(timeouts, player.name)}
                                    waiting={
                                        waiting.filter(
                                            (entry) => entry.username.toLowerCase() === player.name.toLowerCase()
                                        ).length
                                    }
                                    onOpen={(dialog) => setActing({ player, dialog })}
                                    onRevoke={() =>
                                        run(() => actions.revokePlayerAccessAction(installedAppId, player.name))
                                    }
                                />
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {acting?.dialog === "give" && (
                <GiveItemDialog
                    player={acting.player.name}
                    pending={pending}
                    onClose={() => setActing(null)}
                    onGive={(item, count) => {
                        setActing(null);
                        run(() =>
                            actions.givePlayerItemAction({
                                installedAppId,
                                player: acting.player.name,
                                item,
                                count
                            })
                        );
                    }}
                />
            )}
            {acting?.dialog === "teleport" && (
                <TeleportDialog
                    player={acting.player.name}
                    others={onlineNames.filter((name) => name !== acting.player.name)}
                    pending={pending}
                    onClose={() => setActing(null)}
                    onTeleport={(destination) => {
                        setActing(null);
                        run(() =>
                            actions.teleportPlayerAction({
                                installedAppId,
                                player: acting.player.name,
                                destination
                            })
                        );
                    }}
                />
            )}
            {acting?.dialog === "timeout" && (
                <TimeoutDialog
                    player={acting.player.name}
                    pending={pending}
                    onClose={() => setActing(null)}
                    onTimeout={(minutes, reason) => {
                        const player = acting.player.name;
                        setActing(null);
                        const rollback = expect(player, { banned: true, online: false, presence: "offline" });
                        run(
                            () => actions.timeoutPlayerAction({ installedAppId, player, minutes, reason }),
                            rollback
                        );
                    }}
                />
            )}
            {acting?.dialog === "inventory" && (
                <InventoryDialog
                    installedAppId={installedAppId}
                    player={acting.player.name}
                    // Bedrock answers no `data get` at all, so there is nothing to
                    // read live and nothing to write back. Neither is a player who
                    // is not on the server: what is shown then is a snapshot, and
                    // dragging a stack around a copy would write nowhere.
                    canEdit={!bedrock && acting.player.online}
                    onClose={() => setActing(null)}
                />
            )}
            {acting?.dialog === "location" && (
                <LocationDialog
                    installedAppId={installedAppId}
                    player={acting.player.name}
                    onClose={() => setActing(null)}
                />
            )}
            {acting?.dialog === "history" && (
                <HistoryDialog
                    player={acting.player.name}
                    sessions={acting.player.sessions}
                    registered={acting.player.addresses}
                    onClose={() => setActing(null)}
                    onRegister={(address) => {
                        const name = acting.player.name;
                        void addPlayer({ username: name, address });
                    }}
                />
            )}

            {confirmElement}
        </div>
    );
}

function PlayerRow({
    player,
    bedrock,
    answering,
    pending,
    timeout,
    waiting,
    onModerate,
    onModerateWithConfirm,
    onOpen,
    onRevoke
}: {
    player: PlayerEntry;
    bedrock: boolean;
    answering: boolean;
    pending: boolean;
    /** The timeout they are serving, when they are serving one. */
    timeout: PlayerTimeout | null;
    /** How many decisions are still waiting to reach this player. */
    waiting: number;
    onModerate: (input: Omit<MinecraftModeration, "installedAppId">) => void;
    onModerateWithConfirm: (
        input: Omit<MinecraftModeration, "installedAppId">,
        title: string,
        description: string
    ) => Promise<void>;
    onOpen: (dialog: PlayerDialog) => void;
    onRevoke: () => void;
}) {
    const { name } = player;
    // Every verb below is an RCON command, so none of them exist while the server
    // is not answering. Registering and unregistering are Polaris' own and do.
    const live = answering && !pending;

    return (
        <tr className={cn("border-t border-border hover:bg-card-hover", player.banned && "opacity-60")}>
            <td className="px-3 py-2">
                <p className="flex items-center gap-1.5 truncate font-medium" title={name}>
                    {player.operator && <Crown className="size-3.5 shrink-0 text-warning" />}
                    {name}
                </p>
                {(player.note ?? player.banReason) && (
                    <p
                        className="truncate text-xs text-muted-foreground"
                        title={player.banReason ?? player.note ?? undefined}
                    >
                        {player.banReason ?? player.note}
                    </p>
                )}
            </td>
            <td className="px-3 py-2">
                <StatusCell player={player} onOpen={onOpen} />
            </td>
            <td className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-1">
                    {player.addresses.length > 0 && <Badge variant="primary">allowed</Badge>}
                    {player.operator && <Badge>operator</Badge>}
                    {player.whitelisted && <Badge>whitelisted</Badge>}
                    {player.banned &&
                        (timeout ? (
                            <Badge variant="danger" title={`Lifts ${new Date(timeout.until).toLocaleString()}`}>
                                <Timer className="size-3" />
                                timed out, {remaining(timeout.until)}
                            </Badge>
                        ) : (
                            <Badge variant="danger">
                                <Ban className="size-3" />
                                banned
                            </Badge>
                        ))}
                    {/* A name the game knows and Polaris does not is the gap that
                        lets somebody in on the username alone. */}
                    {player.addresses.length === 0 && !player.banned && (
                        <Badge variant="warning">not registered</Badge>
                    )}
                    {/* Something was decided about them that the server has not
                        been told yet. Said on the row rather than only in the list
                        below, because the row is where somebody wonders why their
                        last action appears to have done nothing. */}
                    {waiting > 0 && (
                        <Badge title="Waiting to reach them">
                            <Clock className="size-3" />
                            {waiting} waiting
                        </Badge>
                    )}
                </div>
            </td>
            <td className="hidden px-3 py-2 text-xs text-muted-foreground md:table-cell">
                {/* Every place they play from, not the first one written down.
                    Wrapped rather than truncated: which address is missing is the
                    whole question when somebody cannot get in. */}
                {player.addresses.length === 0 ? (
                    "-"
                ) : (
                    <span className="flex flex-wrap gap-1">
                        {player.addresses.map((address) => (
                            <Badge key={address}>{address}</Badge>
                        ))}
                    </span>
                )}
            </td>
            <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                    {!bedrock && (
                        <IconAction
                            label={player.operator ? `Remove ${name} as operator` : `Make ${name} an operator`}
                            icon={
                                player.operator ? (
                                    <ShieldMinus className="size-4" />
                                ) : (
                                    <ShieldPlus className="size-4" />
                                )
                            }
                            disabled={!live}
                            onClick={() => onModerate({ action: player.operator ? "deop" : "op", player: name })}
                        />
                    )}
                    {!bedrock && (
                        <IconAction
                            label={
                                player.whitelisted
                                    ? `Take ${name} off the whitelist`
                                    : `Put ${name} on the whitelist`
                            }
                            icon={
                                player.whitelisted ? (
                                    <UserMinus className="size-4" />
                                ) : (
                                    <UserPlus className="size-4" />
                                )
                            }
                            disabled={!live}
                            onClick={() =>
                                onModerate({
                                    action: player.whitelisted ? "whitelist-remove" : "whitelist-add",
                                    player: name
                                })
                            }
                        />
                    )}
                    {player.online && (
                        <IconAction
                            label={`Kick ${name}`}
                            icon={<DoorOpen className="size-4" />}
                            disabled={!live}
                            onClick={() =>
                                void onModerateWithConfirm(
                                    { action: "kick", player: name },
                                    `Kick ${name}?`,
                                    "They are disconnected and can join again straight away."
                                )
                            }
                        />
                    )}
                    {!bedrock &&
                        (player.banned ? (
                            <IconAction
                                label={`Lift the ban on ${name}`}
                                icon={<UserPlus className="size-4" />}
                                disabled={!live}
                                onClick={() => onModerate({ action: "pardon", player: name })}
                            />
                        ) : (
                            <IconAction
                                label={`Ban ${name}`}
                                icon={<Ban className="size-4" />}
                                danger
                                disabled={!live}
                                onClick={() =>
                                    void onModerateWithConfirm(
                                        { action: "ban", player: name },
                                        `Ban ${name}?`,
                                        "They are disconnected and cannot rejoin until the ban is lifted."
                                    )
                                }
                            />
                        ))}
                    {player.addresses.length > 0 && (
                        <IconAction
                            label={`Remove ${name} from the player list`}
                            icon={<UserMinus className="size-4" />}
                            danger
                            disabled={pending}
                            onClick={onRevoke}
                        />
                    )}
                    <MoreActions
                        player={player}
                        bedrock={bedrock}
                        live={live}
                        onOpen={onOpen}
                        onModerateWithConfirm={onModerateWithConfirm}
                    />
                </div>
            </td>
        </tr>
    );
}

/**
 * What a player is doing, in the words somebody watching the server would use.
 *
 * Only what the server actually reports. Vanilla Minecraft has no idea of
 * idleness - nothing answers it and nothing prints it - so there is no "away"
 * here: it could only be guessed from how long somebody has been quiet, and a
 * player mining in silence would be labelled away to the operator about to kick
 * them.
 */
function StatusCell({ player, onOpen }: { player: PlayerEntry; onOpen: (dialog: PlayerDialog) => void }) {
    const badge =
        player.presence === "playing" ? (
            <Badge variant="success">Playing</Badge>
        ) : player.presence === "connecting" ? (
            <Badge variant="warning">Connecting</Badge>
        ) : player.presence === "never" ? (
            <Badge>Never joined</Badge>
        ) : (
            <Badge>Offline</Badge>
        );

    return (
        <div className="flex flex-col items-start gap-0.5">
            {badge}
            {player.sessions.length > 0 && (
                <button
                    type="button"
                    onClick={() => onOpen("history")}
                    className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                    title={`When ${player.name} joined and left`}
                >
                    {player.presence === "playing" ? "since " : ""}
                    {relativeTime(player.lastSeen)}
                </button>
            )}
        </div>
    );
}

/** How much of a timeout is left, in the same shape as how long ago. */
function remaining(iso: string): string {
    const minutes = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
    if (minutes < 1) return "lifting now";
    if (minutes < 60) return `${minutes}m left`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours}h left` : `${Math.round(hours / 24)}d left`;
}

/** How long ago, as somebody says it out loud. Absolute below a minute is noise;
 *  past a week the date itself is what an operator wants. */
function relativeTime(iso: string | null): string {
    if (!iso) return "time not logged";
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return "time not logged";
    const seconds = Math.round((Date.now() - at) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days <= 7) return `${days}d ago`;
    return new Date(at).toLocaleDateString();
}

/** The verbs that are not one press: the ones that need a value, and the ones
 *  rare enough that a row of icons for them would bury the three that are not. */
function MoreActions({
    player,
    bedrock,
    live,
    onOpen,
    onModerateWithConfirm
}: {
    player: PlayerEntry;
    bedrock: boolean;
    live: boolean;
    onOpen: (dialog: PlayerDialog) => void;
    onModerateWithConfirm: (
        input: Omit<MinecraftModeration, "installedAppId">,
        title: string,
        description: string
    ) => Promise<void>;
}) {
    // Bedrock answers none of these: it has no RCON, so the console is written to
    // and only the log answers back - there is nothing to read an inventory from.
    if (bedrock) return null;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" aria-label={`More for ${player.name}`} title="More">
                    <MoreHorizontal className="size-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuLabel>{player.name}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {/* Not gated on being online. The question - what were they
                    carrying - is nearly always asked about somebody who logged
                    off, which is what the snapshots are for; gating this on
                    `player.online` put the only door to them behind the one state
                    they do not cover. */}
                <DropdownMenuItem disabled={!live} onSelect={() => onOpen("inventory")}>
                    <Backpack className="size-4" /> Inventory
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!live} onSelect={() => onOpen("give")}>
                    <PackagePlus className="size-4" /> Give an item
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!live || !player.online} onSelect={() => onOpen("location")}>
                    <LocateFixed className="size-4" /> Where they are
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!live || !player.online} onSelect={() => onOpen("teleport")}>
                    <MapPin className="size-4" /> Teleport
                </DropdownMenuItem>
                <DropdownMenuItem disabled={player.sessions.length === 0} onSelect={() => onOpen("history")}>
                    <History className="size-4" /> Joins and leaves
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    className="text-danger"
                    disabled={!live || !player.online}
                    onSelect={() =>
                        void onModerateWithConfirm(
                            { action: "kill", player: player.name },
                            `Kill ${player.name}?`,
                            "They die where they stand and drop what they were carrying. Nothing stops them respawning."
                        )
                    }
                >
                    <Skull className="size-4" /> Kill
                </DropdownMenuItem>
                <DropdownMenuItem className="text-danger" disabled={!live || player.banned} onSelect={() => onOpen("timeout")}>
                    <Timer className="size-4" /> Time out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** Whether the game's own whitelist is enforced at all - a list nobody is checked
 *  against is the commonest way to think you are private and not be. */
function WhitelistSwitch({
    installedAppId,
    enforced,
    disabled,
    onError,
    onChanged
}: {
    installedAppId: string;
    enforced: boolean;
    disabled: boolean;
    onError: (message: string | null) => void;
    onChanged: () => void;
}) {
    const [pending, startTransition] = useTransition();

    return (
        <div className="flex h-10 items-center gap-2 rounded-md border border-border px-3">
            <span className="whitespace-nowrap text-xs text-muted-foreground">
                Whitelist {enforced ? "enforced" : "off"}
            </span>
            <Switch
                checked={enforced}
                disabled={disabled || pending}
                aria-label="Enforce the whitelist"
                onChange={(next) => {
                    onError(null);
                    startTransition(async () => {
                        const result = await actions.setWhitelistEnforcedAction(installedAppId, next);
                        if (result.error) {
                            onError(result.error);
                            return;
                        }
                        onChanged();
                    });
                }}
            />
        </div>
    );
}

/**
 * What the Polaris firewall blocks, and whether this server has been told.
 *
 * The firewall guards HTTP; a game server is not HTTP, so nothing joins the two
 * on its own. Handing its addresses to the server's own ban list is what makes
 * one blocklist mean one thing across the instance - and it is a button rather
 * than something automatic, because banning an address from a game is visible to
 * whoever is playing from it.
 */
export function FirewallSection({
    installedAppId,
    firewall,
    onError,
    onChanged
}: {
    installedAppId: string;
    firewall: MinecraftFirewall | null;
    onError: (message: string | null) => void;
    onChanged: () => void;
}) {
    const [pending, startTransition] = useTransition();
    const [applied, setApplied] = useState<string | null>(null);
    const outstanding = firewall ? firewall.blocked.filter((entry) => !firewall.applied.includes(entry)) : [];

    function apply(): void {
        onError(null);
        startTransition(async () => {
            const result = await actions.applyFirewallBansAction(installedAppId);
            if (result.error) {
                onError(result.error);
                return;
            }
            setApplied(
                result.banned === 0
                    ? "Every blocked address was already banned here"
                    : `Banned ${result.banned} ${result.banned === 1 ? "address" : "addresses"}`
            );
            onChanged();
        });
    }

    if (!firewall || (firewall.blocked.length === 0 && firewall.ranges.length === 0)) return null;

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                        Firewall <span className="text-muted-foreground">{firewall.blocked.length || ""}</span>
                    </p>
                    <Button size="sm" variant="secondary" onClick={apply} disabled={pending || outstanding.length === 0}>
                        <ShieldBan className="size-4" />
                        {outstanding.length === 0 ? "All applied" : `Ban ${outstanding.length} here`}
                    </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                    Addresses the Polaris firewall blocks. A game server refuses them only once they are on its own ban
                    list.
                </p>
                {firewall.ranges.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                        {firewall.ranges.length} {firewall.ranges.length === 1 ? "range is" : "ranges are"} blocked in
                        the firewall. Minecraft bans single addresses only, so those are not applied here.
                    </p>
                )}
                {applied && <p className="text-xs text-muted-foreground">{applied}</p>}
            </CardBody>
        </Card>
    );
}

function IconAction({
    label,
    icon,
    onClick,
    disabled,
    danger
}: {
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
}) {
    return (
        <Button
            size="icon"
            variant="ghost"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            title={label}
            className={danger ? "text-danger hover:text-danger" : undefined}
        >
            {icon}
        </Button>
    );
}
