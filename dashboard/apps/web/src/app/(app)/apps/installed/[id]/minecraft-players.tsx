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
import { GAME_MODES } from "./minecraft-actions";
import { useConfirm } from "@/components/confirm-dialog";
import { ToolbarSwitch } from "@/components/toolbar-switch";
import type { MinecraftModeration } from "./minecraft-actions";
import { ACCESS_REACH_NOTE } from "@/lib/apps/minecraft/access";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { PlayerSessionEvent } from "@/lib/apps/minecraft/sessions";
import { PlayerTimeoutDialog } from "@/components/player-timeout-dialog";
import type { PlayerAccessView } from "@/lib/apps/minecraft/player-access";
import { foldPlayers, type PlayerEntry } from "@/lib/apps/minecraft/players";
import { PlayerIconAction, PlayersTable } from "@/components/game-players-table";
import { describeQueued, waitingOn, type QueuedAction } from "@/lib/apps/minecraft/queue";
import { timeoutFor, timeoutRemaining, type PlayerTimeout } from "@/lib/apps/player-timeout";
import type { MinecraftFirewall, MinecraftRoster, MinecraftStatus } from "@/lib/apps/minecraft/service";
import {
    playerAction,
    playerConfirm,
    playerFilters,
    playerMenuItem,
    playerPresence,
    playerStanding
} from "@/lib/apps/player-vocabulary";
import {
    HistoryDialog,
    InventoryDialog,
    LocationDialog,
    PlayerAccessDialog,
    TeleportDialog,
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
    Skeleton,
    Switch,
    cn
} from "@polaris/ui";
import {
    Backpack,
    Ban,
    Clock,
    Crown,
    DoorOpen,
    Gamepad2,
    History,
    LocateFixed,
    MapPin,
    MoreHorizontal,
    Pencil,
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

/** The cuts an operator reaches for; anything finer is what search is for. Named
 *  once for every game - see `player-vocabulary`. Minecraft has operators, so it
 *  asks for that one. */
const FILTERS = playerFilters({ operators: true });

type Filter = "all" | "online" | "allowed" | "operators" | "banned";

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
    // The player a form is open about, and which form. A null player with the
    // access form open is somebody being registered for the first time.
    const [acting, setActing] = useState<{ player: PlayerEntry | null; dialog: PlayerDialog } | null>(null);
    /** What the server refused the open form with, shown inside it rather than
     *  behind it on a page the reader has stopped looking at. */
    const [formError, setFormError] = useState<string | null>(null);

    const answering = status?.answering ?? false;
    // The row a form is about, as a value rather than a field, so the callbacks
    // inside a dialog still know it cannot be null.
    const target = acting?.player ?? null;
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

    /** Put one or several players into a game mode, and re-read afterwards so the
     *  table shows what the server actually did. */
    async function setGamemode(names: readonly string[], mode: string): Promise<void> {
        setError(null);
        const answer = await actions.setGamemodeAction({ installedAppId, players: names, mode });
        if (answer.error) setError(answer.error);
        onChanged();
    }

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

    /** Register somebody, or save a change to somebody already registered. Both are
     *  one upsert on the pair the server is closed by, so they are one call. */
    function savePlayer(input: { username: string; address: string; note: string }): void {
        setFormError(null);
        startTransition(async () => {
            const result = await actions.grantPlayerAccessAction({
                installedAppId,
                username: input.username,
                address: input.address,
                ...(input.note ? { note: input.note } : {})
            });
            if (result.error) {
                setFormError(result.error);
                return;
            }
            setActing(null);
            onChanged();
        });
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
                            <p className="text-sm font-medium">Who can join</p>
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

            <PlayersTable
                columns={[
                    { label: "Player" },
                    { label: "Status" },
                    { label: "Standing" },
                    { label: "Address", className: "hidden md:table-cell" }
                ]}
                search={query}
                onSearch={setQuery}
                searchPlaceholder="Search by name, address or note"
                filter={filter}
                onFilter={(value) => setFilter(value as Filter)}
                filters={FILTERS}
                toolbar={
                    <>
                        {!bedrock && (
                            <WhitelistSwitch
                                installedAppId={installedAppId}
                                enforced={roster?.whitelistEnforced ?? false}
                                disabled={roster === null || !answering}
                                onError={setError}
                                onChanged={onChanged}
                            />
                        )}
                        <Button
                            onClick={() => {
                                setFormError(null);
                                setActing({ player: null, dialog: "access" });
                            }}
                            disabled={pending}
                        >
                            <UserPlus className="size-4" /> {playerAction.add}
                        </Button>
                    </>
                }
                isEmpty={shown.length === 0}
                empty={
                    !answering && players.length === 0
                        ? (status?.message ?? "Connecting to the server...")
                        : players.length === 0
                          ? "Nobody is registered and nobody is playing."
                          : "Nobody matches that."
                }
                rows={shown.map((player) => (
                    <PlayerRow
                        key={player.name.toLowerCase()}
                        player={player}
                        read={status !== null}
                        bedrock={bedrock}
                        answering={answering}
                        pending={pending}
                        onModerate={moderate}
                        onModerateWithConfirm={moderateWithConfirm}
                        onGamemode={setGamemode}
                        timeout={timeoutFor(timeouts, player.name)}
                        waiting={
                            waiting.filter((entry) => entry.username.toLowerCase() === player.name.toLowerCase())
                                .length
                        }
                        onOpen={(dialog) => setActing({ player, dialog })}
                        onRevoke={() =>
                            void confirm({
                                ...playerConfirm.remove(player.name),
                                confirmLabel: "Remove",
                                danger: true
                            }).then((agreed) => {
                                if (agreed) run(() => actions.revokePlayerAccessAction(installedAppId, player.name));
                            })
                        }
                    />
                ))}
            />

            {acting?.dialog === "access" && (
                <PlayerAccessDialog
                    edition={edition}
                    player={
                        target ? { username: target.name, addresses: target.addresses, note: target.note } : null
                    }
                    pending={pending}
                    error={formError}
                    onClose={() => setActing(null)}
                    onSave={savePlayer}
                    onLookUp={(query) => actions.findMinecraftPlayerByUserAction(installedAppId, query)}
                    onRemoveAddress={(address) => {
                        if (!target) return;
                        const name = target.name;
                        setActing(null);
                        run(() => actions.revokePlayerAddressAction(installedAppId, name, address));
                    }}
                />
            )}
            {acting?.dialog === "teleport" && target && (
                <TeleportDialog
                    player={target.name}
                    others={onlineNames.filter((name) => name !== target.name)}
                    pending={pending}
                    onClose={() => setActing(null)}
                    onTeleport={(destination) => {
                        setActing(null);
                        run(() =>
                            actions.teleportPlayerAction({
                                installedAppId,
                                player: target.name,
                                destination
                            })
                        );
                    }}
                />
            )}
            {acting?.dialog === "timeout" && target && (
                <PlayerTimeoutDialog
                    player={target.name}
                    pending={pending}
                    onClose={() => setActing(null)}
                    onTimeout={(minutes, reason) => {
                        const player = target.name;
                        setActing(null);
                        const rollback = expect(player, { banned: true, online: false, presence: "offline" });
                        run(
                            () => actions.timeoutPlayerAction({ installedAppId, player, minutes, reason }),
                            rollback
                        );
                    }}
                />
            )}
            {acting?.dialog === "inventory" && target && (
                <InventoryDialog
                    installedAppId={installedAppId}
                    player={target.name}
                    // Bedrock answers no `data get` at all, so there is nothing to
                    // read live and nothing to write back. Being offline is not the
                    // same case: the editor says so itself, refuses to move what it
                    // cannot re-read, and still takes an item dropped in from the
                    // palette - which is written down and given when they join.
                    canEdit={!bedrock}
                    onClose={() => setActing(null)}
                    onChanged={onChanged}
                />
            )}
            {acting?.dialog === "location" && target && (
                <LocationDialog
                    installedAppId={installedAppId}
                    player={target.name}
                    onClose={() => setActing(null)}
                />
            )}
            {acting?.dialog === "history" && target && (
                <HistoryDialog
                    installedAppId={installedAppId}
                    player={target.name}
                    sessions={target.sessions}
                    registered={target.addresses}
                    onClose={() => setActing(null)}
                    onRegister={(address) => {
                        const name = target.name;
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
    read,
    bedrock,
    answering,
    pending,
    timeout,
    waiting,
    onModerate,
    onModerateWithConfirm,
    onGamemode,
    onOpen,
    onRevoke
}: {
    player: PlayerEntry;
    /** Whether the server has been asked yet who is on it. Before that nobody is
     *  offline - they are simply not known about, and a grey "Offline" against a
     *  name that is playing is worse than saying nothing. */
    read: boolean;
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
    onGamemode: (players: readonly string[], mode: string) => Promise<void>;
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
                {read ? <StatusCell player={player} onOpen={onOpen} /> : <Skeleton className="h-5 w-16" />}
            </td>
            <td className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-1">
                    {player.addresses.length > 0 && <Badge variant="primary">{playerStanding.allowed}</Badge>}
                    {player.operator && <Badge>{playerStanding.operator}</Badge>}
                    {player.whitelisted && <Badge>whitelisted</Badge>}
                    {player.banned &&
                        (timeout ? (
                            <Badge variant="danger" title={`Lifts ${new Date(timeout.until).toLocaleString()}`}>
                                <Timer className="size-3" />
                                timed out, {timeoutRemaining(timeout.until)}
                            </Badge>
                        ) : (
                            <Badge variant="danger">
                                <Ban className="size-3" />
                                {playerStanding.banned}
                            </Badge>
                        ))}
                    {/* A name the game knows and Polaris does not is the gap that
                        lets somebody in on the username alone. */}
                    {player.addresses.length === 0 && !player.banned && (
                        <Badge variant="warning">{playerStanding.notAllowed}</Badge>
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
                        <PlayerIconAction
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
                        <PlayerIconAction
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
                        <PlayerIconAction
                            label={playerAction.kick(name)}
                            icon={<DoorOpen className="size-4" />}
                            disabled={!live}
                            onClick={() => {
                                const { title, description } = playerConfirm.kick(name);
                                void onModerateWithConfirm({ action: "kick", player: name }, title, description);
                            }}
                        />
                    )}
                    {!bedrock &&
                        (player.banned ? (
                            <PlayerIconAction
                                label={playerAction.pardon(name)}
                                icon={<UserPlus className="size-4" />}
                                disabled={!live}
                                onClick={() => onModerate({ action: "pardon", player: name })}
                            />
                        ) : (
                            <PlayerIconAction
                                label={playerAction.ban(name)}
                                icon={<Ban className="size-4" />}
                                danger
                                disabled={!live}
                                onClick={() => {
                                    const { title, description } = playerConfirm.ban(name);
                                    void onModerateWithConfirm({ action: "ban", player: name }, title, description);
                                }}
                            />
                        ))}
                    {player.addresses.length > 0 && (
                        <PlayerIconAction
                            label={playerAction.remove(name)}
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
                        onGamemode={onGamemode}
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
            <Badge variant="success">{playerPresence.playing}</Badge>
        ) : player.presence === "connecting" ? (
            <Badge variant="warning">{playerPresence.connecting}</Badge>
        ) : player.presence === "never" ? (
            <Badge>{playerPresence.never}</Badge>
        ) : (
            <Badge>{playerPresence.offline}</Badge>
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
    onModerateWithConfirm,
    onGamemode
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
    onGamemode: (players: readonly string[], mode: string) => Promise<void>;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" aria-label={playerAction.more(player.name)} title="More">
                    <MoreHorizontal className="size-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuLabel>{player.name}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {/* Polaris' own record of them - the addresses they may arrive from
                    and the note beside the name - so it does not need the server to
                    be answering, and Bedrock reaches it too. */}
                <DropdownMenuItem onSelect={() => onOpen("access")}>
                    <Pencil className="size-4" /> {playerMenuItem.edit}
                </DropdownMenuItem>
                {/* One door for looking at the bag and for changing what is in it:
                    somebody who opens it to see what is missing is the same person
                    who then hands it over, and they were two forms drawing the
                    same grid twice.

                    Not gated on being online either. The question - what were they
                    carrying - is nearly always asked about somebody who logged
                    off, which is what the snapshots are for, and what cannot happen
                    now is written down and happens when they next join. */}
                <DropdownMenuItem disabled={!live || bedrock} onSelect={() => onOpen("inventory")}>
                    <Backpack className="size-4" /> Inventory and items
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!live || bedrock || !player.online} onSelect={() => onOpen("location")}>
                    <LocateFixed className="size-4" /> Where they are
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!live || bedrock || !player.online} onSelect={() => onOpen("teleport")}>
                    <MapPin className="size-4" /> Teleport
                </DropdownMenuItem>
                {/* Never disabled any more: the record of who played is kept by
                    Polaris now rather than read out of a log that may not reach
                    back far enough, so there is something to show for somebody who
                    has not been on since last month. */}
                <DropdownMenuItem onSelect={() => onOpen("history")}>
                    <History className="size-4" /> {playerMenuItem.history}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* Flat rather than a submenu. Four items is not enough to be worth
                    a second layer somebody has to hover exactly onto. */}
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Game mode</DropdownMenuLabel>
                {GAME_MODES.map((mode) => (
                    <DropdownMenuItem
                        key={mode}
                        disabled={!live || !player.online}
                        onSelect={() => void onGamemode([player.name], mode)}
                    >
                        <Gamepad2 className="size-4" />
                        <span className="capitalize">{mode}</span>
                    </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    className="text-danger"
                    disabled={!live || bedrock || !player.online}
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
                <DropdownMenuItem
                    className="text-danger"
                    disabled={!live || bedrock || player.banned}
                    onSelect={() => onOpen("timeout")}
                >
                    <Timer className="size-4" /> {playerMenuItem.timeout}
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
        <ToolbarSwitch
            label={{ on: "Whitelist enforced", off: "Whitelist off" }}
            checked={enforced}
            disabled={disabled || pending}
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
