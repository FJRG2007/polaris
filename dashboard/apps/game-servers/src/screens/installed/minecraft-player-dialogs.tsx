"use client";

/**
 * The things you do to one player that need more than a click.
 *
 * Kept out of the table because they are all the same shape - name a player, ask
 * for one more thing, send a command - and a table that also holds every form
 * stops being readable. Each one is opened from the row and answers about that
 * row only.
 *
 * Every field is checked here against the same rules the server action checks it
 * against, so a wrong item id says so before it is a failed command in the log.
 * What somebody is carrying is the one that reads and writes, and it owns its own
 * reading: the editor inside it re-reads while the player is on the server, which
 * is not something a one-shot read shared with the others could do.
 */

import * as actions from "./minecraft-actions";
import type { PlayerStats } from "../../lib/games-activity";
import { InventoryEditor } from "./minecraft-inventory-editor";
import { PlayerRecordPanel } from "../../components/player-history";
import type { MinecraftEdition } from "../../lib/minecraft/service";
import type { PlayerRecord } from "../../lib/games-activity-service";
import { useCallback, useEffect, useState, useTransition } from "react";
import type { PlayerSessionEvent } from "../../lib/minecraft/sessions";
import { isAddressRule, isPlayerName } from "../../lib/minecraft/access";
import { PlayerFormDialog, PlayerFormField } from "../../components/player-form-dialog";
import { Loader2, Locate, MapPin, RefreshCw, TriangleAlert, UserSearch, X } from "lucide-react";
import {
    dimensionLabel,
    formatCoordinates,
    type PlayerPosition
} from "../../lib/minecraft/position";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";
import {
    MAX_EXPERIENCE,
    type ExperienceMode,
    type ExperienceUnit
} from "../../lib/minecraft/experience";
import { hostUi } from "@polaris/app-host/client";

const { CopyButton } = hostUi.copyButton;
const { AccountInput } = hostUi.accountInput;

/** Which of the forms is open, or none. */
export type PlayerDialog =
    | "teleport"
    | "timeout"
    | "inventory"
    | "location"
    | "history"
    | "access"
    | "experience";

/**
 * Changing what experience a player has.
 *
 * Three verbs and two units, because the game has three and two - see
 * `minecraft/experience`. The one worth having a form for at all is "set": after
 * a death nobody could avoid, what an operator knows is the number they want the
 * player to be on, not the difference between that and whatever they are on now.
 */
export function ExperienceDialog({
    player,
    pending,
    error,
    onClose,
    onApply
}: {
    player: string;
    pending: boolean;
    error: string | null;
    onClose: () => void;
    onApply: (change: { mode: ExperienceMode; amount: number; unit: ExperienceUnit }) => void;
}) {
    const [mode, setMode] = useState<ExperienceMode>("add");
    const [unit, setUnit] = useState<ExperienceUnit>("levels");
    const [amount, setAmount] = useState(1);

    return (
        <PlayerFormDialog
            title={`${player}'s experience`}
            description="Applied to the player standing on the server, so they see it happen."
            confirmLabel={
                mode === "set" ? "Set it" : mode === "remove" ? "Take it away" : "Give it"
            }
            ready={amount >= 0}
            pending={pending}
            error={error}
            danger={mode === "remove"}
            onClose={onClose}
            onConfirm={() => onApply({ mode, amount, unit })}
        >
            <PlayerFormField label="What to do">
                <Select
                    value={mode}
                    aria-label="What to do"
                    onValueChange={(next) => setMode(next as ExperienceMode)}
                    options={[
                        { value: "add", label: "Give them" },
                        { value: "remove", label: "Take away" },
                        { value: "set", label: "Put them on" }
                    ]}
                />
            </PlayerFormField>

            <PlayerFormField
                label="How much"
                hint={
                    unit === "levels"
                        ? "Levels are what the player sees over their hotbar."
                        : "Points are what a level is made of, and a level costs more of them the higher it is."
                }
            >
                <div className="flex items-center gap-2">
                    <Input
                        autoFocus
                        type="number"
                        min={0}
                        max={MAX_EXPERIENCE}
                        value={amount}
                        aria-label="How much"
                        className="w-28"
                        onChange={(event) =>
                            setAmount(
                                Math.max(
                                    0,
                                    Math.min(MAX_EXPERIENCE, Number(event.target.value) || 0)
                                )
                            )
                        }
                    />
                    <Select
                        value={unit}
                        className="w-32"
                        aria-label="Levels or points"
                        onValueChange={(next) => setUnit(next as ExperienceUnit)}
                        options={[
                            { value: "levels", label: "levels" },
                            { value: "points", label: "points" }
                        ]}
                    />
                </div>
            </PlayerFormField>
        </PlayerFormDialog>
    );
}

/** Three coordinates, absolute or `~` relative. */
const COORDINATES =
    /^~?-?\d{1,7}(?:\.\d{1,3})?\s+~?-?\d{1,7}(?:\.\d{1,3})?\s+~?-?\d{1,7}(?:\.\d{1,3})?$/;

/** A Java account name, which a teleport destination may also be. */
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

export function TeleportDialog({
    player,
    others,
    pending,
    onClose,
    onTeleport
}: {
    player: string;
    /** Everyone else on right now, since "to whoever" is the common case. */
    others: readonly string[];
    pending: boolean;
    onClose: () => void;
    onTeleport: (destination: string) => void;
}) {
    const [destination, setDestination] = useState("");
    const value = destination.trim();
    const valid = PLAYER_NAME.test(value) || COORDINATES.test(value);
    const error =
        value.length > 0 && !valid
            ? "A player's name, or three coordinates like 100 64 -220"
            : null;

    return (
        <PlayerFormDialog
            title={`Teleport ${player}`}
            description="To another player who is on, or to a place."
            onClose={onClose}
            pending={pending}
            ready={valid && !pending}
            confirmLabel="Teleport"
            onConfirm={() => onTeleport(value)}
        >
            {others.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {others.map((name) => (
                        <Button
                            key={name}
                            size="sm"
                            variant="secondary"
                            onClick={() => setDestination(name)}
                        >
                            {name}
                        </Button>
                    ))}
                </div>
            )}
            <PlayerFormField label="Player or coordinates" error={error}>
                <Input
                    autoFocus
                    value={destination}
                    spellCheck={false}
                    placeholder="Alice, or 100 64 -220"
                    onChange={(event) => setDestination(event.target.value)}
                />
            </PlayerFormField>
        </PlayerFormDialog>
    );
}

/**
 * What a player is carrying, and everything done to it.
 *
 * One screen rather than two. Looking at a bag and handing somebody an item were
 * separate forms, which meant an operator who opened the first to see what was
 * missing had to close it and open the second to do anything about it - and the
 * second drew the same bag again, from its own read.
 *
 * The editor owns the reading and the refreshing: while the player is on the
 * server it re-reads every couple of seconds so two people moving things around
 * see the same bag, and it stops while a drag is in the air. Nothing here waits
 * on that read - the grid is drawn empty and fills in - because a dialog that is
 * a spinner for a second is a dialog somebody presses twice.
 */
export function InventoryDialog({
    installedAppId,
    player,
    canEdit,
    others,
    onClose,
    onChanged
}: {
    installedAppId: string;
    player: string;
    /** False for a viewer who may look and not touch, and on Bedrock, whose
     *  commands cannot answer this at all. */
    canEdit: boolean;
    /** Everybody else who is on right now, for sending stacks to. */
    others: readonly string[];
    onClose: () => void;
    /** The screen behind lists what is waiting to reach this player too, so a
     *  write that lands in that queue has to ask it to read the list again. */
    onChanged: () => void;
}) {
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>{player}&apos;s inventory</DialogTitle>
                    <DialogDescription>
                        {canEdit
                            ? "Drag to rearrange it, or drop an item from the palette into a slot."
                            : "As the server last had it."}
                    </DialogDescription>
                </DialogHeader>
                <InventoryEditor
                    installedAppId={installedAppId}
                    player={player}
                    editable={canEdit}
                    others={others}
                    onChanged={onChanged}
                />
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Where a player is, and the coordinates in a form worth pasting.
 *
 * Read on demand rather than shown in the table: every reading is a command sent
 * to the running server, and one per player per poll would be a moderation screen
 * that costs the server more than the players do.
 */
export function LocationDialog({
    installedAppId,
    player,
    onClose
}: {
    installedAppId: string;
    player: string;
    onClose: () => void;
}) {
    const read = useCallback(
        () => actions.readPlayerPositionAction(installedAppId, player),
        [installedAppId, player]
    );
    const { data, error, loading, refresh } = useServerRead(read);
    const position = data?.position ?? null;

    return (
        <Reading
            title={`Where ${player} is`}
            description="Read from the running server, so it is where they were a moment ago."
            icon={<MapPin className="size-6" />}
            loadingLabel="Asking the server..."
            empty="The server did not say."
            loading={loading}
            error={error}
            onRefresh={refresh}
            onClose={onClose}
        >
            {position && <Coordinates player={player} position={position} />}
        </Reading>
    );
}

/** The three numbers, big enough to read off the screen and copyable as the one
 *  string that goes into a `tp` or a note. */
function Coordinates({ player, position }: { player: string; position: PlayerPosition }) {
    const coordinates = formatCoordinates(position);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2">
                <dl className="flex gap-4">
                    {(["X", "Y", "Z"] as const).map((axis, index) => (
                        <div key={axis}>
                            <dt className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                                {axis}
                            </dt>
                            <dd className="font-mono text-lg tabular-nums">
                                {coordinates.split(" ")[index]}
                            </dd>
                        </div>
                    ))}
                </dl>
                <CopyButton
                    value={coordinates}
                    label={`${player}'s coordinates`}
                    className="size-8"
                />
            </div>
            <p className="text-xs text-muted-foreground">
                {position.dimension ? dimensionLabel(position.dimension) : "World not reported"} -
                exactly{" "}
                <span className="font-mono">
                    {position.x.toFixed(2)} {position.y.toFixed(2)} {position.z.toFixed(2)}
                </span>
            </p>
        </div>
    );
}

/** One read of the running server, with the states a read has, in the shape the
 *  frame below expects. The bag no longer goes through it - a screen that is
 *  written to has to re-read itself, which is the editor's own job. */
function useServerRead<T extends { error?: string }>(
    read: () => Promise<T>
): {
    data: T | null;
    error: string | null;
    loading: boolean;
    refresh: () => void;
} {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let live = true;
        setLoading(true);
        setError(null);
        void read().then(
            (result) => {
                if (!live) return;
                setLoading(false);
                if (result.error) setError(result.error);
                else setData(result);
            },
            () => {
                if (!live) return;
                setLoading(false);
                setError("Could not reach the server");
            }
        );
        return () => {
            live = false;
        };
    }, [read, attempt]);

    return { data, error, loading, refresh: () => setAttempt((count) => count + 1) };
}

/** The frame around something read out of the server: the states, the refresh and
 *  the way out. */
function Reading({
    title,
    description,
    icon,
    loadingLabel,
    empty,
    loading,
    error,
    children,
    onRefresh,
    onClose
}: {
    title: string;
    description: string;
    icon: React.ReactNode;
    loadingLabel: string;
    /** What to say when the read worked and there was nothing in it. */
    empty: string;
    loading: boolean;
    error: string | null;
    /** The reading itself, or nothing when there was none. */
    children: React.ReactNode;
    onRefresh: () => void;
    onClose: () => void;
}) {
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                {loading ? (
                    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" /> {loadingLabel}
                    </p>
                ) : error ? (
                    <p className="flex items-start gap-2 py-6 text-sm text-danger">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                        {error}
                    </p>
                ) : children ? (
                    children
                ) : (
                    <p className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
                        {icon}
                        {empty}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="secondary" onClick={onRefresh} disabled={loading}>
                        <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
                        Refresh
                    </Button>
                    <Button variant="ghost" onClick={onClose}>
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** What the record read comes back as. Declared here rather than exported from the
 *  actions file, which may only export the actions themselves. */
interface PlayerRecordReading {
    readonly record: PlayerRecord | null;
    readonly stats: PlayerStats | null;
}

/**
 * What somebody has done on this server: what it adds up to, then every visit.
 *
 * Two records behind it and they cover different ground. Polaris's own goes back
 * to whenever it started watching and knows the times; the world's own statistics
 * were counted by the server itself and cover everything that ever happened on it,
 * including before any of this existed. Whichever is missing simply does not draw.
 */
export function HistoryDialog({
    installedAppId,
    player,
    sessions,
    registered = [],
    onClose,
    onRegister
}: {
    installedAppId: string;
    player: string;
    sessions: readonly PlayerSessionEvent[];
    /** The addresses this player is already allowed from, so the ones that are
     *  not can be offered rather than left as text somebody retypes. */
    registered?: readonly string[];
    onClose: () => void;
    /** Absent when the viewer may not change the list. */
    onRegister?: (address: string) => void;
}) {
    const newestFirst = [...sessions].reverse();
    const known = new Set(registered);
    const [record, setRecord] = useState<PlayerRecordReading | null>(null);
    const [reading, setReading] = useState(true);

    // The kept record is a database read rather than something the page already
    // has, so it arrives after the dialog does. The log-derived list below draws
    // immediately either way, which is why this never blocks anything.
    useEffect(() => {
        let live = true;
        void actions.readPlayerRecordAction(installedAppId, player).then((answer) => {
            if (!live) return;
            setRecord(
                answer.error ? null : { record: answer.record ?? null, stats: answer.stats ?? null }
            );
            setReading(false);
        });
        return () => {
            live = false;
        };
    }, [installedAppId, player]);

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{player} on this server</DialogTitle>
                    <DialogDescription>
                        What Polaris has watched, and what the world itself has counted.
                    </DialogDescription>
                </DialogHeader>

                <PlayerRecordPanel
                    record={record?.record ?? null}
                    stats={record?.stats ?? null}
                    loading={reading}
                />

                {newestFirst.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                        Nothing in the log this far back.
                    </p>
                ) : (
                    <ul className="max-h-80 divide-y divide-border overflow-y-auto overscroll-contain text-sm">
                        {newestFirst.map((event, index) => (
                            <li
                                key={`${event.at ?? "unknown"}-${event.kind}-${index}`}
                                className="flex items-center justify-between gap-3 py-1.5"
                            >
                                <span
                                    className={
                                        event.kind === "join"
                                            ? "text-success"
                                            : "text-muted-foreground"
                                    }
                                >
                                    {event.kind === "join" ? "Joined" : "Left"}
                                </span>
                                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                                    {event.address && (
                                        <span className="font-mono">{event.address}</span>
                                    )}
                                    {/* The address is right here and the list is
                                        one click away, which is the whole reason
                                        several of them per player is worth having:
                                        somebody who moved house adds the new line
                                        from the log rather than retyping it. */}
                                    {event.address && onRegister && !known.has(event.address) && (
                                        <button
                                            type="button"
                                            className="text-primary hover:underline"
                                            onClick={() => onRegister(event.address as string)}
                                        >
                                            Allow this address
                                        </button>
                                    )}
                                    <span>
                                        {event.at
                                            ? new Date(event.at).toLocaleString()
                                            : "time not logged"}
                                    </span>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Who may connect, and from where - as a form rather than a row of fields parked
 * under the table.
 *
 * The same form adds somebody and edits them, which is what makes a note or a
 * second address fixable at all: before this the only way to change anything about
 * a registered player was to remove them and put them back, and on a closed server
 * that is a window where nobody can get in.
 *
 * The username is the identity the server checks, so it is not editable - a
 * different name is a different person, and renaming one silently would leave the
 * old one registered.
 */
export function PlayerAccessDialog({
    edition,
    player,
    pending,
    error,
    onClose,
    onSave,
    onRemoveAddress,
    onLookUp,
    onLink,
    onUnlink,
    onInvite
}: {
    edition: MinecraftEdition;
    /** The player being edited, or null to register somebody new. */
    player: {
        username: string;
        addresses: readonly string[];
        note: string | null;
        linkedTo?: { userId: string; name: string; followSignIns?: boolean; } | null;
    } | null;
    pending: boolean;
    error: string | null;
    onClose: () => void;
    onSave: (input: { username: string; address: string; note: string; }) => void;
    onRemoveAddress?: (address: string) => void;
    /** Find somebody by their Polaris name and hand back the Minecraft username
     *  they linked, plus the addresses their account is signed in from. Absent on
     *  a screen where nobody may look people up. */
    onLookUp?: (query: string) => Promise<{
        userId?: string;
        username?: string;
        name?: string;
        addresses?: string[];
        error?: string;
    }>;
    /** Tie the player to a Polaris account. `followSignIns` false keeps the
     *  addresses typed for them; `address` and `note` are then saved with it. */
    onLink?: (input: {
        username: string;
        userId: string;
        followSignIns: boolean;
        address?: string;
        note?: string;
    }) => void;
    /** Untie a linked player. */
    onUnlink?: (username: string) => void;
    /** Invite somebody with no Polaris account, so the one they make is tied to
     *  this player. */
    onInvite?: (input: { username: string; email: string; followSignIns: boolean; }) => Promise<{
        linked?: true;
        invite?: { url?: string; sendError?: string; };
        error?: string;
    }>;
}) {
    const editing = player !== null;
    const linkedTo = player?.linkedTo ?? null;
    /** Linked, and their addresses are the account's sign-ins - which is the one
     *  case where nothing here is typed. A link that only says who they are
     *  leaves the addresses and the note as editable as before. */
    const following = linkedTo !== null && linkedTo.followSignIns !== false;
    /** The Polaris account a look-up found, which the player can be tied to. */
    const [account, setAccount] = useState<{ userId: string; name: string; } | null>(null);
    /** Whether the player follows that account's sign-ins or keeps typed
     *  addresses. Bedrock reports no address, so it can only keep them. */
    const [follow, setFollow] = useState(edition === "java");
    const [noMinecraft, setNoMinecraft] = useState(false);
    const [username, setUsername] = useState(player?.username ?? "");
    const [address, setAddress] = useState("");
    const [note, setNote] = useState(player?.note ?? "");
    const [detecting, startDetecting] = useTransition();
    const [detectFailed, setDetectFailed] = useState(false);
    const [person, setPerson] = useState("");
    const [lookUpError, setLookUpError] = useState<string | null>(null);
    const [looking, startLooking] = useTransition();
    /** Where that account signs in from, offered under the address field. */
    const [suggested, setSuggested] = useState<readonly string[]>([]);
    const [inviting, startInviting] = useTransition();
    const [invited, setInvited] = useState<{ email: string; url?: string; sendError?: string; } | null>(
        null
    );
    const [inviteError, setInviteError] = useState<string | null>(null);

    /** Fill the name in from a Polaris account, spelled the way Mojang spells it. */
    function lookUp(query: string): void {
        const identifier = query.trim();
        if (!onLookUp || identifier.length === 0) return;
        setLookUpError(null);
        setInviteError(null);
        setInvited(null);
        startLooking(async () => {
            const found = await onLookUp(identifier);
            if (found.error || !found.userId) {
                setLookUpError(found.error ?? "Could not look that up");
                setSuggested([]);
                setAccount(null);
                return;
            }
            setAccount({ userId: found.userId, name: found.name ?? identifier });
            setNoMinecraft(!found.username);
            // The name of somebody already on the list is who the server checks,
            // and an account can be tied to it whatever that account calls itself.
            if (found.username && !editing) setUsername(found.username);
            if (found.name && note.trim().length === 0) setNote(found.name);
            setSuggested(found.addresses ?? []);
            // The common case is one address, and making somebody click it when
            // it is the only answer is a step that decides nothing. More than one
            // is a real choice, so it is left to them.
            if (found.addresses?.length === 1 && address.trim().length === 0) {
                setAddress(found.addresses[0] as string);
            }
        });
    }

    const name = editing ? player.username : username.trim();
    const rule = address.trim();
    // Only the addresses that would change something: one already in the field,
    // or already registered to this player, is not an offer.
    const offer = suggested.filter(
        (known) => known !== rule && !(player?.addresses ?? []).includes(known)
    );
    const nameInvalid = !editing && name.length > 0 && !isPlayerName(edition, name);
    const addressInvalid = rule.length > 0 && !isAddressRule(rule);
    // Editing without touching the address is how a note is changed; the note is
    // stored against a rule, so the one they already have carries it.
    const noteChanged = editing && note.trim() !== (player.note ?? "");
    const hasAddresses = (player?.addresses.length ?? 0) > 0;
    const followsNow = follow && edition === "java";
    // Tying the player to an account that was just found.
    const linking = account !== null && Boolean(onLink) && !linkedTo;
    // What the addresses have to be for the form to be complete: nothing when
    // they will follow sign-ins, otherwise a new one or one already registered.
    const addressesReady =
        isAddressRule(rule) || (rule.length === 0 && editing && hasAddresses);
    const ready = following
        ? true
        : linking
          ? isPlayerName(edition, name) && (followsNow || addressesReady)
          : editing
            ? isAddressRule(rule) || (rule.length === 0 && noteChanged && hasAddresses)
            : isPlayerName(edition, name) && isAddressRule(rule);
    // An email that matched nobody: offer to invite them instead.
    const inviteEmail = person.trim().includes("@") ? person.trim().toLowerCase() : null;
    const canInvite =
        Boolean(onInvite) &&
        !linkedTo &&
        account === null &&
        lookUpError !== null &&
        inviteEmail !== null &&
        isPlayerName(edition, name);

    function detect(): void {
        setDetectFailed(false);
        startDetecting(async () => {
            const result = await actions.myAddressAction();
            if (!result.address) {
                setDetectFailed(true);
                return;
            }
            setAddress(result.address);
        });
    }

    function invite(): void {
        if (!onInvite || !inviteEmail) return;
        setInviteError(null);
        startInviting(async () => {
            const result = await onInvite({
                username: name,
                email: inviteEmail,
                followSignIns: followsNow
            });
            if (result.error) {
                setInviteError(result.error);
                return;
            }
            if (result.linked) {
                onClose();
                return;
            }
            setInvited({ email: inviteEmail, ...result.invite });
        });
    }

    return (
        <PlayerFormDialog
            title={editing ? `Edit ${player.username}` : "Add a player"}
            description={
                following
                    ? `${player?.username} joins from wherever ${linkedTo?.name} is signed in to Polaris.`
                    : linkedTo
                      ? `${player?.username} is ${linkedTo.name} on Polaris. Where they join from is the addresses below.`
                      : editing
                        ? "Add another address they play from, change the note, or tie them to a Polaris account. The name itself is what the server checks."
                        : "A player is let in when the name is on this list and they arrive from an address registered to it."
            }
            confirmLabel={following || invited ? "Done" : linking ? "Link" : editing ? "Save" : "Add player"}
            ready={ready || invited !== null}
            pending={pending || inviting}
            error={error}
            onClose={onClose}
            onConfirm={() => {
                if (following || invited) {
                    onClose();
                    return;
                }
                if (linking && account && onLink) {
                    onLink({
                        username: name,
                        userId: account.userId,
                        followSignIns: followsNow,
                        ...(followsNow
                            ? {}
                            : {
                                  address: rule.length > 0 ? rule : (player?.addresses[0] ?? ""),
                                  note: note.trim()
                              })
                    });
                    return;
                }
                onSave({
                    username: name,
                    address: rule.length > 0 ? rule : (player?.addresses[0] ?? ""),
                    note: note.trim()
                });
            }}
        >
            {!linkedTo && onLookUp && (
                <PlayerFormField
                    label={editing ? "Their Polaris account" : "Somebody with a Polaris account"}
                    error={lookUpError}
                    hint={
                        editing
                            ? "Any account, whatever it is called and whether or not it has linked Minecraft. An email that is nobody yet can be invited."
                            : "If they have linked Minecraft, their name and the addresses they connect from fill themselves in."
                    }
                >
                    <div className="flex items-center gap-1">
                        <AccountInput
                            autoFocus={!editing}
                            value={person}
                            onValueChange={(value) => {
                                setPerson(value);
                                setInvited(null);
                            }}
                            // Choosing somebody off the list is the errand, so it
                            // is not also worth a button press. A name that was
                            // typed rather than picked still is.
                            onPick={(picked) => lookUp(picked.username || picked.email)}
                            onEnter={() => lookUp(person)}
                            placeholder="pau, or pau@example.com"
                            aria-label="Polaris username or email address"
                        />
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => lookUp(person)}
                            disabled={looking || person.trim().length === 0}
                            aria-label="Find their Polaris account"
                            title="Find their Polaris account"
                        >
                            {looking ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <UserSearch className="size-4" />
                            )}
                        </Button>
                    </div>
                    {canInvite && !invited && (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                            <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                disabled={inviting}
                                onClick={invite}
                            >
                                {inviting && <Loader2 className="size-3.5 animate-spin" />}
                                Invite {inviteEmail}
                            </Button>
                            <span className="text-xs text-muted-foreground">
                                The account they make is tied to {name}.
                            </span>
                        </div>
                    )}
                    {inviteError && <p className="pt-1 text-xs text-danger">{inviteError}</p>}
                    {invited && (
                        <div className="flex flex-col gap-1 pt-1 text-xs text-muted-foreground">
                            <span>
                                {invited.sendError
                                    ? `The email to ${invited.email} could not be sent (${invited.sendError}). Send them this link instead.`
                                    : invited.url
                                      ? `Send ${invited.email} this link. When they make their account, it is tied to ${name}.`
                                      : `Invited ${invited.email}. When they make their account, it is tied to ${name}.`}
                            </span>
                            {invited.url && (
                                <span className="flex items-center gap-1">
                                    <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5">
                                        {invited.url}
                                    </code>
                                    <CopyButton value={invited.url} label="the invite link" />
                                </span>
                            )}
                        </div>
                    )}
                </PlayerFormField>
            )}

            {linking && account && edition === "java" && (
                <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">
                        Where {account.name} can join from
                    </span>
                    <div
                        className="flex flex-wrap gap-1"
                        role="radiogroup"
                        aria-label="Where they can join from"
                    >
                        <Button
                            type="button"
                            size="sm"
                            role="radio"
                            aria-checked={follow}
                            variant={follow ? "secondary" : "ghost"}
                            onClick={() => setFollow(true)}
                        >
                            Wherever they are signed in to Polaris
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            role="radio"
                            aria-checked={!follow}
                            variant={follow ? "ghost" : "secondary"}
                            onClick={() => setFollow(false)}
                        >
                            {editing && hasAddresses ? "Keep these addresses" : "A fixed address"}
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {follow
                            ? `They are let in only from an address where ${account.name} is signed in to Polaris, and removed when they sign out.${editing && hasAddresses ? " The addresses typed for them go." : ""}`
                            : `Linked to ${account.name} for who they are. The addresses typed here still decide where they join from.`}
                    </p>
                </div>
            )}

            <PlayerFormField
                label={edition === "bedrock" ? "Gamertag" : "Username"}
                error={nameInvalid ? "That is not a username this edition accepts" : null}
                hint={
                    !editing && account && noMinecraft
                        ? `${account.name} has not linked Minecraft, so type their username.`
                        : undefined
                }
            >
                <Input
                    value={editing ? player.username : username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder={edition === "bedrock" ? "Gamertag" : "Username"}
                    disabled={editing}
                    aria-label="Player"
                />
            </PlayerFormField>

            {linkedTo && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                    <span className="text-xs text-muted-foreground">
                        {!following
                            ? `Linked to ${linkedTo.name}.`
                            : player?.addresses.length
                              ? `Follows ${linkedTo.name}'s Polaris sign-ins.`
                              : `${linkedTo.name} is not signed in to Polaris anywhere, so ${player?.username} cannot join right now.`}
                    </span>
                    {onUnlink && player && (
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-danger hover:text-danger"
                            disabled={pending}
                            onClick={() => onUnlink(player.username)}
                        >
                            Unlink
                        </Button>
                    )}
                </div>
            )}

            {editing && player.addresses.length > 0 && !(linking && followsNow) && (
                <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">
                        {following ? "Signed in from" : "Addresses they play from"}
                    </span>
                    <div className="flex flex-wrap gap-1">
                        {player.addresses.map((held) => (
                            <span
                                key={held}
                                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
                            >
                                {held}
                                {onRemoveAddress && !following && (
                                    <button
                                        type="button"
                                        disabled={pending}
                                        aria-label={`Remove ${held} from ${player.username}`}
                                        title={`Remove ${held}`}
                                        className="text-muted-foreground hover:text-danger disabled:opacity-50"
                                        onClick={() => onRemoveAddress(held)}
                                    >
                                        <X className="size-3" />
                                    </button>
                                )}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {!following && !(linking && followsNow) && (
                <PlayerFormField
                    label={editing ? "Another address" : "Address they connect from"}
                    error={addressInvalid ? "That is not an address or a range" : null}
                    hint={
                        detectFailed
                            ? "Polaris could not read the address this request came from. Type it in instead."
                            : editing
                              ? "Leave it empty to change only the note."
                              : undefined
                    }
                >
                    <div className="flex items-center gap-1">
                        <Input
                            autoFocus={editing && Boolean(linkedTo)}
                            value={address}
                            onChange={(event) => setAddress(event.target.value)}
                            placeholder="203.0.113.9, 203.0.113.0/24 or any"
                            aria-label="Address they connect from"
                        />
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={detect}
                            disabled={pending || detecting}
                            aria-label="Use the address you are on now"
                            title="Use the address you are on now"
                        >
                            {detecting ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <Locate className="size-4" />
                            )}
                        </Button>
                    </div>
                    {/* Where that account signs in to Polaris from. The operator doing
                    this is on their own line, so the detect button beside the
                    field is the wrong address for everybody but themselves. */}
                    {offer.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1 pt-1">
                            <span className="text-xs text-muted-foreground">They sign in from</span>
                            {offer.map((known) => (
                                <button
                                    key={known}
                                    type="button"
                                    className="rounded-md border border-border px-2 py-0.5 font-mono text-xs hover:bg-muted"
                                    onClick={() => setAddress(known)}
                                >
                                    {known}
                                </button>
                            ))}
                        </div>
                    )}
                </PlayerFormField>
            )}

            {!following && !(linking && followsNow) && (
                <PlayerFormField
                    label="Note"
                    hint="Who this is, for whoever reads the list next. Only Polaris sees it."
                >
                    <Input
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Who this is"
                        maxLength={120}
                        aria-label="Note"
                    />
                </PlayerFormField>
            )}
        </PlayerFormDialog>
    );
}
