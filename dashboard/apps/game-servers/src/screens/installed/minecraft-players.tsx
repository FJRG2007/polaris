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
import {
    type GameText,
    timeoutText,
    useGameText,
    usePlayerWords,
    useSchemaText
} from "../game-text";
import type { PlayerWords } from "../../lib/player-vocabulary";
import { forgetLoginAction } from "./minecraft-login-actions";
import type { PlayerSeen } from "../../lib/games-activity";
import type { MinecraftModeration } from "./minecraft-actions";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { PlayerSessionEvent } from "../../lib/minecraft/sessions";
import { PlayerTimeoutDialog } from "../../components/player-timeout-dialog";
import type { PlayerAccessView } from "../../lib/minecraft/player-access";
import type { RememberedLevel } from "../../lib/minecraft/level-memory";
import { PlayerIconAction, PlayersTable } from "../../components/game-players-table";
import { RowContextMenu, RowMenuButton, type RowMenuEntry } from "../../components/row-menu";
import { InventoryExportMenu, InventoryImportButton } from "./minecraft-inventory-transfer";
import { foldPlayers, GAME_MODES, type PlayerEntry } from "../../lib/minecraft/players";
import type { QueuedAction } from "../../lib/minecraft/queue";
import { describeQueuedText, waitingOnText } from "./queue-text";
import { timeoutFor, type PlayerTimeout } from "../../lib/player-timeout";
import type {
    MinecraftFirewall,
    MinecraftRoster,
    MinecraftStatus
} from "../../lib/minecraft/service";
import {
    DisconnectLabel,
    ExperienceDialog,
    HistoryDialog,
    InventoryDialog,
    LocationDialog,
    PlayerAccessDialog,
    TeleportDialog,
    type PlayerDialog
} from "./minecraft-player-dialogs";
import { Badge, Button, Card, CardBody, Skeleton, Switch, cn } from "@polaris/ui";
import {
    Backpack,
    Ban,
    Clock,
    Crown,
    DoorOpen,
    Gamepad2,
    History,
    KeyRound,
    LocateFixed,
    MapPin,
    Pencil,
    RotateCcw,
    ShieldBan,
    ShieldMinus,
    ShieldPlus,
    Skull,
    Sparkles,
    Timer,
    UserMinus,
    UserPlus,
    Users,
    X
} from "lucide-react";
import { hostUi } from "@polaris/app-host/client";

const { relativeTime } = hostUi.relativeTime;
const { useConfirm } = hostUi.confirmDialog;
const { ToolbarSwitch } = hostUi.toolbarSwitch;
const { useDisplayFormat } = hostUi.displayFormat;

/** Nobody known to be idle: the screen before the first answer about it. */
const NOBODY_IDLE: Readonly<Record<string, number>> = {};

type Filter = "all" | "online" | "allowed" | "operators" | "banned";

export function MinecraftPlayers({
    installedAppId,
    status,
    roster,
    rosterAsOf,
    access,
    sessions,
    seen,
    now,
    timeouts,
    levels,
    idle = NOBODY_IDLE,
    lastLevels,
    pending: waiting,
    passwords,
    canResetPasswords,
    onPasswordsChanged,
    onChanged
}: {
    installedAppId: string;
    status: MinecraftStatus | null;
    roster: MinecraftRoster | null;
    /**
     * When that roster was read, for a server that has since stopped answering.
     *
     * Null while it is answering, which is what "this is current" looks like. The
     * roster itself comes out of files inside the container, so a stopped server
     * has none - and a whitelist drawn as off because nobody could be asked says
     * the opposite of the truth about a server that is closed by default.
     */
    rosterAsOf: string | null;
    /** Who may connect and from where - the list the server is actually closed by. */
    access: PlayerAccessView | null;
    /** Who arrived and who left, out of the server's log. */
    sessions: readonly PlayerSessionEvent[];
    /** When Polaris last watched each of them, for the rows the log no longer
     *  reaches back to. */
    seen: Readonly<Record<string, PlayerSeen>>;
    /** The server's clock when it read them. */
    now: number;
    /** Bans with an end, and when each one lifts. */
    timeouts: readonly PlayerTimeout[];
    /** What experience level each player who is on has reached, by name. Only
     *  players standing on the server have one, and only Java can be asked. */
    levels: Readonly<Record<string, number>>;
    /** Since when each player on has not moved, turned or fought, by name. */
    idle?: Readonly<Record<string, number>>;
    /** The level each player was last seen on, for the rows of players who are
     *  not on right now. */
    lastLevels: Readonly<Record<string, RememberedLevel>>;
    /** Decisions the server could not be told yet, oldest first. */
    pending: readonly QueuedAction[];
    /** Who has a Polaris login password here, or null on a server that does not
     *  use it - where no row says anything about passwords. */
    passwords?: readonly { readonly name: string; readonly lastLoginAt: string | null }[] | null;
    /** Resetting one takes the manage grant; this screen only takes read. */
    canResetPasswords?: boolean;
    onPasswordsChanged?: () => void;
    onChanged: () => void;
}) {
    const schemaText = useSchemaText();
    const { playerAction, playerConfirm, playerFilters } = usePlayerWords();
    const t = useGameText("minecraft");
    /** Whether a player's addresses follow a Polaris account's sign-ins. */
    const followsSignIns = (player: string): boolean =>
        (access?.links ?? []).some(
            (link) => link.followSignIns && link.username.toLowerCase() === player.toLowerCase()
        );
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    // Refusals cleared here, hidden at once and put back if the save fails.
    const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
    const refusals = (access?.refusals ?? []).filter(
        (refusal) => !cleared.has("all") && !cleared.has(`${refusal.player}-${refusal.at}`)
    );

    function clearRefusal(which: { player: string; at: string } | "all") {
        const key = which === "all" ? "all" : `${which.player}-${which.at}`;
        setCleared((was) => new Set(was).add(key));
        run(
            () => actions.dismissRefusalAction(installedAppId, which),
            () =>
                setCleared((was) => {
                    const next = new Set(was);
                    next.delete(key);
                    return next;
                })
        );
    }
    const [confirm, confirmElement] = useConfirm();
    // How this reader has asked for times to be written. Held here as well as in
    // the row below, because the toolbar now says when a remembered roster was
    // read, and that is a time like any other on this screen.
    const format = useDisplayFormat();
    // What the operator has just changed, shown until the server's own answer
    // catches up. Keyed by the same lowercase name the lists are folded on.
    const [applied, setApplied] = useState<Map<string, Partial<PlayerEntry>>>(new Map());
    // The player a form is open about, and which form. A null player with the
    // access form open is somebody being registered for the first time.
    const [acting, setActing] = useState<{
        player: PlayerEntry | null;
        dialog: PlayerDialog;
    } | null>(null);
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
        () => foldPlayers(status, roster, access, sessions, now, seen, passwords ?? []),
        [status, roster, access, sessions, now, seen, passwords]
    );
    const players = useMemo(
        () =>
            known.map((player) => ({
                ...player,
                ...(applied.get(player.name.toLowerCase()) ?? {})
            })),
        [known, applied]
    );
    const registered = access?.rules.length ?? 0;
    // Folded to lower case, because the server reports a name the way it stored
    // it and the table may be drawing it the way the operator typed it.
    const remembered = useMemo(
        () =>
            new Map(Object.entries(lastLevels).map(([name, value]) => [name.toLowerCase(), value])),
        [lastLevels]
    );
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
        if (
            !(await confirm({
                title,
                description,
                confirmLabel: t("playersTab.confirm"),
                danger: true
            }))
        )
            return;
        moderate(input);
    }

    /** Forget somebody's Polaris login password, so they set a new one on their
     *  next join. Nothing restarts: the mod asks on every join. */
    async function resetPassword(player: string): Promise<void> {
        const agreed = await confirm({
            title: t("playersTab.resetTitle", { name: player }),
            description: t("playersTab.resetBody", { name: player }),
            confirmLabel: t("playersTab.resetPassword"),
            danger: true
        });
        if (!agreed) return;
        run(async () => {
            const result = await forgetLoginAction({ installedAppId, player });
            if (!result.error) onPasswordsChanged?.();
            return result;
        });
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

    /**
     * Tie somebody to a Polaris account - following its sign-ins, or only as who
     * they are, in which case the address and note typed with it are saved too.
     */
    function linkPlayer(input: {
        username: string;
        userId: string;
        followSignIns: boolean;
        address?: string;
        note?: string;
    }): void {
        setFormError(null);
        startTransition(async () => {
            const result = await actions.linkPlayerAccountAction({
                installedAppId,
                username: input.username,
                userId: input.userId,
                followSignIns: input.followSignIns
            });
            if (result.error) {
                setFormError(result.error);
                return;
            }
            if (!input.followSignIns && input.address) {
                const saved = await actions.grantPlayerAccessAction({
                    installedAppId,
                    username: input.username,
                    address: input.address,
                    ...(input.note ? { note: input.note } : {})
                });
                if (saved.error) {
                    setFormError(saved.error);
                    onChanged();
                    return;
                }
            }
            setActing(null);
            onChanged();
        });
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
            {note && <p className="text-sm text-muted-foreground">{note}</p>}

            {/* A server with an empty list is one nobody on earth can join, and
                nothing anywhere saying why. It is also the state a server lands in
                when its first player was removed, so it is worth naming loudly. */}
            {access !== null && registered === 0 && (
                <Card className="border-warning-edge bg-warning-soft">
                    <CardBody className="flex flex-col gap-1">
                        <p className="flex items-center gap-2 text-sm font-medium">
                            <Users className="size-4 text-warning" />
                            {t("playersTab.nobodyCanJoinYet")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                            {edition === "bedrock"
                                ? t("playersTab.closedHintBedrock")
                                : t("playersTab.closedHintJava")}
                        </p>
                    </CardBody>
                </Card>
            )}

            {/* Somebody thrown out is the one thing on this screen that happened
                to a person who is not looking at it. They were told to ask the
                server's owner; this is the owner being asked. Most of these are a
                home connection that changed address on its own overnight, which is
                why the answer offered is the address they actually arrived from
                rather than a form to fill in. */}
            {refusals.length > 0 && (
                <Card className="border-warning-edge bg-warning-soft">
                    <CardBody className="flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-2">
                            <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                                <Users className="size-4 shrink-0 text-warning" />
                                {t("playersTab.turnedAwayRecently")}
                            </p>
                            {refusals.length > 1 && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={pending}
                                    onClick={() => clearRefusal("all")}
                                >
                                    {t("playersTab.dismissAllRefusals")}
                                </Button>
                            )}
                        </div>
                        {refusals.map((refusal) => {
                            const from = refusal.address;
                            const linked = followsSignIns(refusal.player);
                            return (
                                <div
                                    key={`${refusal.player}-${refusal.at}`}
                                    className="flex flex-wrap items-center gap-2 text-sm"
                                >
                                    <span className="font-medium">{refusal.player}</span>
                                    <span className="text-muted-foreground">
                                        {from
                                            ? t("playersTab.arrivedFrom", { address: from })
                                            : t("playersTab.arrivedFromAnAddressThe")}
                                        {" - "}
                                        {format.dateTime(refusal.at)}
                                    </span>
                                    {from && (
                                        <Button
                                            size="sm"
                                            variant="secondary"
                                            disabled={pending}
                                            onClick={() =>
                                                run(() =>
                                                    actions.grantPlayerAccessAction({
                                                        installedAppId,
                                                        username: refusal.player,
                                                        address: from,
                                                        note: t("playersTab.addedFromRefusal")
                                                    })
                                                )
                                            }
                                        >
                                            {t("playersTab.allowThisAddressToo")}
                                        </Button>
                                    )}
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="ml-auto"
                                        disabled={pending}
                                        aria-label={t("playersTab.dismissRefusal")}
                                        title={t("playersTab.dismissRefusal")}
                                        onClick={() =>
                                            clearRefusal({ player: refusal.player, at: refusal.at })
                                        }
                                    >
                                        <X aria-hidden="true" className="size-3.5" />
                                    </Button>
                                    {/* Where they may connect from follows their
                                        Polaris sign-ins, so the reason is a
                                        sign-in missing from that connection, not
                                        an address that changed. */}
                                    {linked && (
                                        <p className="basis-full text-xs text-muted-foreground">
                                            {t("playersTab.notSignedInThere", {
                                                player: refusal.player
                                            })}
                                        </p>
                                    )}
                                </div>
                            );
                        })}
                        {refusals.some((refusal) => !followsSignIns(refusal.player)) && (
                            <p className="text-xs text-muted-foreground">
                                {t("playersTab.aHomeConnectionIsGiven")}
                            </p>
                        )}
                    </CardBody>
                </Card>
            )}

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <p className="text-sm font-medium">{t("playersTab.whoCanJoin")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("playersTab.whoCanJoinHint")} {t("access.reachNote")}
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                                {access?.bindAddresses
                                    ? t("playersTab.addressChecked")
                                    : t("playersTab.addressNotChecked")}
                            </span>
                            <Switch
                                checked={access?.bindAddresses ?? true}
                                onChange={(enabled) =>
                                    run(() =>
                                        actions.setAddressBindingAction(installedAppId, enabled)
                                    )
                                }
                                disabled={pending || access === null || !access.addressesAvailable}
                                aria-label={t("playersTab.checkEachPlayerSAddress")}
                            />
                        </div>
                    </div>
                    {access && !access.addressesAvailable && (
                        <p className="text-xs text-muted-foreground">
                            {t("playersTab.bedrockDoesNotRecordWhere")}
                        </p>
                    )}
                </CardBody>
            </Card>

            {waiting.length > 0 && (
                <Card>
                    <CardBody className="flex flex-col gap-2">
                        <div>
                            <p className="text-sm font-medium">{t("playersTab.waitingToHappen")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("playersTab.decidedWhileTheServerOr")}
                            </p>
                        </div>
                        <ul className="flex flex-col divide-y divide-border/60">
                            {waiting.map((entry) => (
                                <li
                                    key={entry.id}
                                    className="flex items-center justify-between gap-3 py-2"
                                >
                                    <div className="min-w-0">
                                        <p className="truncate text-sm">
                                            {entry.username}: {describeQueuedText(t, entry)}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {t("playersTab.lapses", {
                                                reason: entry.lastError ?? waitingOnText(t, entry),
                                                date: new Date(entry.expiresAt).toLocaleDateString()
                                            })}
                                        </p>
                                    </div>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        disabled={pending}
                                        aria-label={t("playersTab.cancelFor", {
                                            what: describeQueuedText(t, entry),
                                            name: entry.username
                                        })}
                                        title={t("playersTab.cancelFor", {
                                            what: describeQueuedText(t, entry),
                                            name: entry.username
                                        })}
                                        onClick={() =>
                                            startTransition(async () => {
                                                const result =
                                                    await actions.cancelQueuedActionAction(
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
                    { label: t("playersTab.player") },
                    // Left out entirely on Bedrock rather than drawn empty: it has
                    // no way to be asked what level somebody is on, and a column of
                    // dashes reads as a server where nobody has levelled.
                    ...(bedrock ? [] : [{ label: t("playersTab.level") }]),
                    { label: t("playersTab.status") },
                    { label: t("playersTab.standing") },
                    { label: t("playersTab.address"), className: "hidden md:table-cell" }
                ]}
                search={query}
                onSearch={setQuery}
                searchPlaceholder={t("playersTab.searchPlaceholder")}
                filter={filter}
                onFilter={(value) => setFilter(value as Filter)}
                // The cuts an operator reaches for, named once for every game - see
                // `player-vocabulary`. Minecraft has operators, so it asks for that one.
                filters={playerFilters({ operators: true })}
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
                        {/* Outside the Java-only switch, because what it dates is
                            not Java-only: a Bedrock server that is off draws its
                            remembered allow list from the same note - operators
                            it never has, being kept there by xuid rather than by
                            name - and without this those names read as what the
                            server is saying right now. The one thing worse than
                            not knowing whether a server is closed is believing
                            the wrong thing about it. */}
                        {rosterAsOf ? (
                            <span className="text-xs text-muted-foreground">
                                {t("playersTab.asRead", {
                                    when: relativeTime(
                                        rosterAsOf,
                                        format,
                                        t("playersTab.unknownTime")
                                    )
                                })}
                            </span>
                        ) : null}
                        {/* Every bag at once, as a file: Java only, which is where a
                            bag can be read back and written slot by slot. */}
                        {!bedrock && (
                            <>
                                <InventoryExportMenu
                                    installedAppId={installedAppId}
                                    players="all"
                                    onMessage={(message) => {
                                        setNote(message.note ?? null);
                                        setError(message.error ?? null);
                                    }}
                                />
                                <InventoryImportButton
                                    installedAppId={installedAppId}
                                    onDone={onChanged}
                                />
                            </>
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
                        ? (schemaText(status?.message) ?? t("playersTab.connecting"))
                        : players.length === 0
                          ? t("playersTab.nobodyAtAll")
                          : t("playersTab.nobodyMatches")
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
                        level={levels[player.name] ?? null}
                        lastLevel={remembered.get(player.name.toLowerCase()) ?? null}
                        idleSince={idle[player.name] ?? null}
                        now={now}
                        timeout={timeoutFor(timeouts, player.name)}
                        waiting={
                            waiting.filter(
                                (entry) =>
                                    entry.username.toLowerCase() === player.name.toLowerCase()
                            ).length
                        }
                        onOpen={(dialog) => setActing({ player, dialog })}
                        passwords={passwords != null}
                        onResetPassword={
                            canResetPasswords && player.password
                                ? () => void resetPassword(player.name)
                                : undefined
                        }
                        onRevoke={() =>
                            void confirm({
                                ...playerConfirm.remove(player.name),
                                confirmLabel: t("playersTab.remove"),
                                danger: true
                            }).then((agreed) => {
                                if (agreed)
                                    run(() =>
                                        actions.revokePlayerAccessAction(
                                            installedAppId,
                                            player.name
                                        )
                                    );
                            })
                        }
                    />
                ))}
            />

            {acting?.dialog === "access" && (
                <PlayerAccessDialog
                    edition={edition}
                    player={
                        target
                            ? {
                                  username: target.name,
                                  addresses: target.addresses,
                                  note: target.note,
                                  linkedTo: target.linkedTo
                              }
                            : null
                    }
                    onLink={linkPlayer}
                    onInvite={async (input) => {
                        const result = await actions.invitePlayerAccountAction({
                            installedAppId,
                            ...input
                        });
                        if (!result.error) onChanged();
                        return result;
                    }}
                    onUnlink={(username) => {
                        void confirm({
                            title: t("playersTab.unlinkTitle", { name: username }),
                            description: target?.addresses.length
                                ? t("playersTab.unlinkBodyAddresses", { name: username })
                                : t("playersTab.unlinkBody", { name: username }),
                            confirmLabel: t("playersTab.unlink"),
                            danger: true
                        }).then((agreed) => {
                            if (!agreed) return;
                            setActing(null);
                            run(() => actions.unlinkPlayerAccountAction(installedAppId, username));
                        });
                    }}
                    pending={pending}
                    error={formError}
                    onClose={() => setActing(null)}
                    onSave={savePlayer}
                    onLookUp={(query) =>
                        actions.findMinecraftPlayerByUserAction(installedAppId, query)
                    }
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
            {acting?.dialog === "experience" && target && (
                <ExperienceDialog
                    player={target.name}
                    pending={pending}
                    error={null}
                    onClose={() => setActing(null)}
                    onApply={(change) => {
                        const player = target.name;
                        setActing(null);
                        run(() =>
                            actions.setPlayerExperienceAction({ installedAppId, player, ...change })
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
                        const rollback = expect(player, {
                            banned: true,
                            online: false,
                            presence: "offline"
                        });
                        run(
                            () =>
                                actions.timeoutPlayerAction({
                                    installedAppId,
                                    player,
                                    minutes,
                                    reason
                                }),
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
                    others={onlineNames.filter(
                        (name) => name.toLowerCase() !== target.name.toLowerCase()
                    )}
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
    level,
    lastLevel,
    idleSince,
    now,
    waiting,
    onModerate,
    onModerateWithConfirm,
    onGamemode,
    onOpen,
    passwords,
    onResetPassword,
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
    /** The experience level they are on, or null for somebody who is not standing
     *  on the server - nobody who is away has one to report. */
    level: number | null;
    /** The level they were on the last time they were, for somebody who is not
     *  on now. */
    lastLevel: RememberedLevel | null;
    /** Since when they have been AFK, while they are; null while they are not or
     *  when not known. */
    idleSince: number | null;
    /** The server's clock. */
    now: number;
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
    /** Whether the server asks for a Polaris login password. */
    passwords: boolean;
    /** Forget their password, when they have one and the viewer may. */
    onResetPassword?: () => void;
    onRevoke: () => void;
}) {
    const schemaText = useSchemaText();
    const { playerAction, playerStanding } = usePlayerWords();
    const t = useGameText("minecraft");
    const tGames = useGameText("games");
    const { name } = player;
    // Every verb below is an RCON command, so none of them exist while the server
    // is not answering. Registering and unregistering are Polaris' own and do.
    const live = answering && !pending;
    const format = useDisplayFormat();

    // Everything this row can do, in one list: the icons at its end, and the
    // longer set behind the `...`. The right button gets both, which is what
    // anybody who has used a file manager tries first on a table of names.
    const words = usePlayerWords();
    const quick = quickEntries({
        t,
        words,
        player,
        bedrock,
        live,
        pending,
        onModerate,
        onModerateWithConfirm,
        onRevoke
    });
    const more = moreEntries({
        t,
        words,
        player,
        bedrock,
        live,
        onOpen,
        onModerateWithConfirm,
        onGamemode,
        onResetPassword
    });

    return (
        <RowContextMenu entries={[...quick, { kind: "separator" } as const, ...more]}>
            <tr
                className={cn(
                    "border-t border-border hover:bg-card-hover",
                    player.banned && "opacity-60"
                )}
            >
                <td className="px-3 py-2">
                    <p className="flex items-center gap-1.5 truncate font-medium" title={name}>
                        {player.operator && <Crown className="size-3.5 shrink-0 text-warning" />}
                        {name}
                    </p>
                    {(player.note ?? player.banReason) && (
                        <p
                            className="truncate text-xs text-muted-foreground"
                            title={schemaText(player.banReason ?? player.note ?? undefined)}
                        >
                            {schemaText(player.banReason ?? player.note ?? undefined)}
                        </p>
                    )}
                </td>
                {/* Only the players who are standing on the server have a level to
                report: it is read out of the running world, not out of a file. For
                somebody who is away it is the one they were last seen on, muted and
                dated, and a dash only when Polaris has never seen one. */}
                {!bedrock && (
                    <td className="px-3 py-2 tabular-nums">
                        {level === null && lastLevel !== null ? (
                            <span
                                className="text-muted-foreground"
                                title={t("playersTab.lastLevel", {
                                    level: lastLevel.level,
                                    date: format.dateTime(lastLevel.at)
                                })}
                            >
                                {lastLevel.level}
                            </span>
                        ) : level === null ? (
                            <span
                                className="text-muted-foreground"
                                title={
                                    player.online
                                        ? t("playersTab.theServerHasNotAnswered")
                                        : t("playersTab.onlyPlayersWhoAreOn")
                                }
                            >
                                -
                            </span>
                        ) : (
                            level
                        )}
                    </td>
                )}
                <td className="px-3 py-2">
                    {read ? (
                        <StatusCell
                            player={player}
                            idleSince={idleSince}
                            now={now}
                            onOpen={onOpen}
                        />
                    ) : (
                        <Skeleton className="h-5 w-16" />
                    )}
                </td>
                <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1">
                        {player.linkedTo && (
                            <Badge
                                title={t("playersTab.linkedHint", {
                                    name: schemaText(player.linkedTo.name) ?? ""
                                })}
                            >
                                {t("playersTab.linked")}
                            </Badge>
                        )}
                        {player.addresses.length > 0 && (
                            <Badge variant="primary">{playerStanding.allowed}</Badge>
                        )}
                        {player.operator && <Badge>{playerStanding.operator}</Badge>}
                        {player.whitelisted && <Badge>{t("playersTab.whitelisted")}</Badge>}
                        {/* Whether they can get past Polaris login, on the servers that
                        ask for it. Somebody without one sets it on their next join. */}
                        {passwords &&
                            (player.password ? (
                                <Badge
                                    variant="success"
                                    title={
                                        player.password.lastLoginAt
                                            ? t("playersTab.lastLogin", {
                                                  date: new Date(
                                                      player.password.lastLoginAt
                                                  ).toLocaleString()
                                              })
                                            : t("playersTab.hasNotLoggedInSince")
                                    }
                                >
                                    <KeyRound className="size-3" />
                                    {t("playersTab.passwordSet")}
                                </Badge>
                            ) : (
                                <Badge title={t("playersTab.setsOneOnTheirNext")}>
                                    {t("playersTab.noPasswordYet")}
                                </Badge>
                            ))}
                        {player.banned &&
                            (timeout ? (
                                <Badge
                                    variant="danger"
                                    title={t("playersTab.lifts", {
                                        date: new Date(timeout.until).toLocaleString()
                                    })}
                                >
                                    <Timer className="size-3" />
                                    {t("playersTab.timedOut", {
                                        left: timeoutText(tGames, timeout.until)
                                    })}
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
                            <Badge title={t("playersTab.waitingToReachThem")}>
                                <Clock className="size-3" />
                                {t("playersTab.waitingCount", { count: waiting })}
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
                                <Badge key={address}>{schemaText(address)}</Badge>
                            ))}
                        </span>
                    )}
                </td>
                <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                        {/* The same verbs the right button offers, as icons. Both are
                        drawn from `quick` so a verb added to one is in the other. */}
                        {quick.map((entry, index) =>
                            entry.kind === "item" ? (
                                <PlayerIconAction
                                    key={index}
                                    label={entry.text}
                                    icon={entry.icon}
                                    danger={entry.danger}
                                    disabled={entry.disabled}
                                    onClick={entry.onSelect}
                                />
                            ) : null
                        )}
                        <RowMenuButton entries={more} label={playerAction.more(name)} />
                    </div>
                </td>
            </tr>
        </RowContextMenu>
    );
}

/** How often a row's relative times are worked out again. They are in minutes. */
const RELATIVE_TICK_MS = 30_000;

/** The time now, moved on every `everyMs`, for a component whose text says how
 *  long ago something was. */
function useClock(everyMs: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), everyMs);
        return () => clearInterval(timer);
    }, [everyMs]);
    return now;
}

/**
 * What a player is doing, in the words somebody watching the server would use.
 *
 * AFK is read from outside the game, which has no idea of it: nobody who has
 * moved, turned their head or fought in the last few minutes is AFK, so a
 * player mining in silence is still playing - quiet in the chat is not the
 * test. Somebody standing still and looking at one spot the whole time is.
 */
function StatusCell({
    player,
    idleSince,
    now,
    onOpen
}: {
    player: PlayerEntry;
    /** Since when they have been AFK, while they are; null while they are not. */
    idleSince: number | null;
    /** The server's clock, which the time above was read against. */
    now: number;
    onOpen: (dialog: PlayerDialog) => void;
}) {
    const { playerPresence } = usePlayerWords();
    const t = useGameText("minecraft");
    const format = useDisplayFormat();
    // "since 3m ago" is a phrase inside a sentence, so it cannot be the element
    // that re-renders itself; the row's own clock moves it on instead.
    const clock = useClock(RELATIVE_TICK_MS);
    const away = player.presence === "playing" && idleSince !== null;
    const badge = away ? (
        <Badge
            variant="warning"
            title={t("playersTab.idle", {
                name: player.name,
                minutes: Math.floor((now - idleSince) / 60_000)
            })}
        >
            {playerPresence.afk}
        </Badge>
    ) : player.presence === "playing" ? (
        <Badge variant="success">{playerPresence.playing}</Badge>
    ) : player.presence === "connecting" ? (
        <Badge variant="warning">{playerPresence.connecting}</Badge>
    ) : player.presence === "never" ? (
        <Badge>{playerPresence.never}</Badge>
    ) : (
        <Badge>{playerPresence.offline}</Badge>
    );

    // Why they last went, or why the server last turned them away - the line
    // somebody looking at an offline player is usually asking about.
    const lastWord = player.presence === "playing" ? null : (player.sessions.at(-1) ?? null);
    const visits = player.sessions.some((event) => event.kind !== "refused");

    return (
        <div className="flex flex-col items-start gap-0.5">
            {badge}
            {lastWord && lastWord.kind !== "join" && lastWord.reason ? (
                <span className="text-xs">
                    {lastWord.kind === "refused" ? (
                        <span className="text-warning">{t("disconnect.refused")}</span>
                    ) : null}
                    <DisconnectLabel reason={lastWord.reason} />
                </span>
            ) : null}
            {/* Somebody playing gets a line only with the start of the visit they are
                on: nothing is better than a time that answers another question. */}
            {(player.lastSeen !== null || (player.presence !== "playing" && visits)) && (
                <button
                    type="button"
                    onClick={() => onOpen("history")}
                    className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                    title={t("playersTab.historyOf", { name: player.name })}
                >
                    {t(player.presence === "playing" ? "playersTab.since" : "playersTab.lastOn", {
                        when: relativeTime(
                            player.lastSeen,
                            format,
                            t("players.timeNotLogged"),
                            clock
                        )
                    })}
                </button>
            )}
        </div>
    );
}

/**
 * The verbs at the end of a row: the three or four anybody presses, as icons.
 *
 * A list rather than the buttons themselves, because the right button offers the
 * same verbs and neither copy may be the one that gets a new one. Which of them
 * exist at all is a per-player question - Bedrock has no operator list, an
 * address can only be forgotten by somebody who has one - so the list is built
 * rather than filtered on the way out.
 */
function quickEntries({
    player,
    bedrock,
    live,
    pending,
    onModerate,
    onModerateWithConfirm,
    onRevoke,
    t,
    words
}: {
    t: GameText<"minecraft">;
    words: PlayerWords;
    player: PlayerEntry;
    bedrock: boolean;
    live: boolean;
    pending: boolean;
    onModerate: (input: Omit<MinecraftModeration, "installedAppId">) => void;
    onModerateWithConfirm: (
        input: Omit<MinecraftModeration, "installedAppId">,
        title: string,
        description: string
    ) => Promise<void>;
    onRevoke: () => void;
}): RowMenuEntry[] {
    const { playerAction, playerConfirm } = words;
    const { name } = player;
    const entries: RowMenuEntry[] = [];

    if (!bedrock) {
        entries.push({
            kind: "item",
            text: player.operator ? t("playersTab.deop", { name }) : t("playersTab.op", { name }),
            icon: player.operator ? (
                <ShieldMinus className="size-4" />
            ) : (
                <ShieldPlus className="size-4" />
            ),
            disabled: !live,
            onSelect: () => onModerate({ action: player.operator ? "deop" : "op", player: name })
        });
        entries.push({
            kind: "item",
            text: player.whitelisted
                ? t("playersTab.unwhitelist", { name })
                : t("playersTab.whitelist", { name }),
            icon: player.whitelisted ? (
                <UserMinus className="size-4" />
            ) : (
                <UserPlus className="size-4" />
            ),
            disabled: !live,
            onSelect: () =>
                onModerate({
                    action: player.whitelisted ? "whitelist-remove" : "whitelist-add",
                    player: name
                })
        });
    }

    if (player.online) {
        entries.push({
            kind: "item",
            text: playerAction.kick(name),
            icon: <DoorOpen className="size-4" />,
            disabled: !live,
            onSelect: () => {
                const { title, description } = playerConfirm.kick(name);
                void onModerateWithConfirm({ action: "kick", player: name }, title, description);
            }
        });
    }

    if (!bedrock) {
        entries.push(
            player.banned
                ? {
                      kind: "item",
                      text: playerAction.pardon(name),
                      icon: <UserPlus className="size-4" />,
                      disabled: !live,
                      onSelect: () => onModerate({ action: "pardon", player: name })
                  }
                : {
                      kind: "item",
                      text: playerAction.ban(name),
                      icon: <Ban className="size-4" />,
                      danger: true,
                      disabled: !live,
                      onSelect: () => {
                          const { title, description } = playerConfirm.ban(name);
                          void onModerateWithConfirm(
                              { action: "ban", player: name },
                              title,
                              description
                          );
                      }
                  }
        );
    }

    if (player.addresses.length > 0) {
        entries.push({
            kind: "item",
            text: playerAction.remove(name),
            icon: <UserMinus className="size-4" />,
            danger: true,
            disabled: pending,
            onSelect: onRevoke
        });
    }

    return entries;
}

/** The verbs that are not one press: the ones that need a value, and the ones
 *  rare enough that a row of icons for them would bury the three that are not. */
function moreEntries({
    player,
    bedrock,
    live,
    onOpen,
    onModerateWithConfirm,
    onGamemode,
    onResetPassword,
    t,
    words
}: {
    t: GameText<"minecraft">;
    words: PlayerWords;
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
    onResetPassword?: () => void;
}): RowMenuEntry[] {
    const { playerMenuItem } = words;
    return [
        { kind: "label", text: player.name },
        { kind: "separator" },
        // The record Polaris keeps of them - the addresses they may arrive from
        // and the note beside the name - so it does not need the server to be
        // answering, and Bedrock reaches it too.
        {
            kind: "item",
            text: playerMenuItem.edit,
            icon: <Pencil className="size-4" />,
            onSelect: () => onOpen("access")
        },
        // One door for looking at the bag and for changing what is in it: somebody
        // who opens it to see what is missing is the same person who then hands it
        // over, and they were two forms drawing the same grid twice.
        //
        // Not gated on being online either. The question - what were they carrying
        // - is nearly always asked about somebody who logged off, which is what
        // the snapshots are for, and what cannot happen now is written down and
        // happens when they next join.
        {
            kind: "item",
            text: t("playersTab.menu.inventory"),
            icon: <Backpack className="size-4" />,
            disabled: !live || bedrock,
            onSelect: () => onOpen("inventory")
        },
        {
            kind: "item",
            text: t("playersTab.menu.location"),
            icon: <LocateFixed className="size-4" />,
            disabled: !live || bedrock || !player.online,
            onSelect: () => onOpen("location")
        },
        {
            kind: "item",
            text: t("playersTab.menu.teleport"),
            icon: <MapPin className="size-4" />,
            disabled: !live || bedrock || !player.online,
            onSelect: () => onOpen("teleport")
        },
        // Only while they are on: the game changes a bar on a player who is
        // standing there, and there is nothing to write down for somebody who is
        // not.
        {
            kind: "item",
            text: t("playersTab.menu.experience"),
            icon: <Sparkles className="size-4" />,
            disabled: !live || bedrock || !player.online,
            onSelect: () => onOpen("experience")
        },
        // Never disabled any more: the record of who played is kept by Polaris
        // now rather than read out of a log that may not reach back far enough,
        // so there is something to show for somebody who has not been on since
        // last month.
        {
            kind: "item",
            text: playerMenuItem.history,
            icon: <History className="size-4" />,
            onSelect: () => onOpen("history")
        },
        // The password is kept by Polaris, so this works whether or not the
        // server is answering.
        ...(onResetPassword
            ? ([
                  {
                      kind: "item",
                      text: t("playersTab.menu.resetPassword"),
                      icon: <RotateCcw className="size-4" />,
                      onSelect: onResetPassword
                  }
              ] as RowMenuEntry[])
            : []),
        { kind: "separator" },
        // Flat rather than a submenu. Four items is not enough to be worth a
        // second layer somebody has to hover exactly onto.
        { kind: "label", text: t("playersTab.menu.gameMode"), muted: true },
        ...GAME_MODES.map(
            (mode): RowMenuEntry => ({
                kind: "item",
                text: t(`playersTab.modes.${mode}`),
                icon: <Gamepad2 className="size-4" />,
                disabled: !live || !player.online,
                onSelect: () => void onGamemode([player.name], mode)
            })
        ),
        { kind: "separator" },
        {
            kind: "item",
            text: t("playersTab.menu.kill"),
            icon: <Skull className="size-4" />,
            danger: true,
            disabled: !live || bedrock || !player.online,
            onSelect: () =>
                void onModerateWithConfirm(
                    { action: "kill", player: player.name },
                    t("playersTab.killTitle", { name: player.name }),
                    t("playersTab.killBody")
                )
        },
        {
            kind: "item",
            text: playerMenuItem.timeout,
            icon: <Timer className="size-4" />,
            danger: true,
            disabled: !live || bedrock || player.banned,
            onSelect: () => onOpen("timeout")
        }
    ];
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
    const t = useGameText("minecraft");
    const [pending, startTransition] = useTransition();

    return (
        <ToolbarSwitch
            label={{ on: t("playersTab.whitelistOn"), off: t("playersTab.whitelistOff") }}
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
    const t = useGameText("minecraft");
    const [pending, startTransition] = useTransition();
    const [applied, setApplied] = useState<string | null>(null);
    const outstanding = firewall
        ? firewall.blocked.filter((entry) => !firewall.applied.includes(entry))
        : [];

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
                    ? t("playersTab.allBanned")
                    : t("playersTab.bannedCount", { count: result.banned })
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
                        {t("playersTab.firewall")}{" "}
                        <span className="text-muted-foreground">
                            {firewall.blocked.length || ""}
                        </span>
                    </p>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={apply}
                        disabled={pending || outstanding.length === 0}
                    >
                        <ShieldBan className="size-4" />
                        {outstanding.length === 0
                            ? t("playersTab.allApplied")
                            : t("playersTab.banHere", { count: outstanding.length })}
                    </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                    {t("playersTab.addressesThePolarisFirewallBlocks")}
                </p>
                {firewall.ranges.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                        {t("playersTab.rangesBlocked", { count: firewall.ranges.length })}
                    </p>
                )}
                {applied && <p className="text-xs text-muted-foreground">{applied}</p>}
            </CardBody>
        </Card>
    );
}
