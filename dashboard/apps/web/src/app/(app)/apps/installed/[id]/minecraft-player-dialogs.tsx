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
import { CopyButton } from "@/components/copy-button";
import { AccountInput } from "@/components/account-input";
import { InventoryEditor } from "./minecraft-inventory-editor";
import { MAX_TIMEOUT_MINUTES } from "@/lib/apps/minecraft/timeout";
import type { MinecraftEdition } from "@/lib/apps/minecraft/service";
import { useCallback, useEffect, useState, useTransition } from "react";
import type { PlayerSessionEvent } from "@/lib/apps/minecraft/sessions";
import { isAddressRule, isPlayerName } from "@/lib/apps/minecraft/access";
import { PlayerFormDialog, PlayerFormField } from "@/components/player-form-dialog";
import { Loader2, Locate, MapPin, RefreshCw, TriangleAlert, UserSearch, X } from "lucide-react";
import { dimensionLabel, formatCoordinates, type PlayerPosition } from "@/lib/apps/minecraft/position";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Select } from "@polaris/ui";

/** Which of the forms is open, or none. */
export type PlayerDialog = "teleport" | "timeout" | "inventory" | "location" | "history" | "access";

/** Three coordinates, absolute or `~` relative. */
const COORDINATES = /^~?-?\d{1,7}(?:\.\d{1,3})?\s+~?-?\d{1,7}(?:\.\d{1,3})?\s+~?-?\d{1,7}(?:\.\d{1,3})?$/;

/** A Java account name, which a teleport destination may also be. */
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

/** The lengths a moderator actually reaches for, and the one that means "the rest
 *  of the day". Anything else is typed. */
const TIMEOUT_PRESETS = [
    { value: "5", label: "5 minutes" },
    { value: "15", label: "15 minutes" },
    { value: "60", label: "1 hour" },
    { value: "480", label: "8 hours" },
    { value: "1440", label: "1 day" },
    { value: "custom", label: "Another length" }
];

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
    const error = value.length > 0 && !valid ? "A player's name, or three coordinates like 100 64 -220" : null;

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
                        <Button key={name} size="sm" variant="secondary" onClick={() => setDestination(name)}>
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

export function TimeoutDialog({
    player,
    pending,
    onClose,
    onTimeout
}: {
    player: string;
    pending: boolean;
    onClose: () => void;
    onTimeout: (minutes: number, reason: string) => void;
}) {
    const [preset, setPreset] = useState("15");
    const [custom, setCustom] = useState("30");
    const [reason, setReason] = useState("");
    const minutes = preset === "custom" ? Number.parseInt(custom, 10) : Number.parseInt(preset, 10);
    const error =
        !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TIMEOUT_MINUTES
            ? `Between 1 minute and ${MAX_TIMEOUT_MINUTES / (24 * 60)} days`
            : null;

    return (
        <PlayerFormDialog
            title={`Time ${player} out`}
            description="They are banned now and let back in when it runs out, without anybody having to remember."
            onClose={onClose}
            pending={pending}
            ready={!error && !pending}
            confirmLabel="Time out"
            danger
            onConfirm={() => onTimeout(minutes, reason.trim())}
        >
            <PlayerFormField label="How long">
                <Select
                    value={preset}
                    onValueChange={setPreset}
                    options={TIMEOUT_PRESETS}
                    aria-label="How long the timeout lasts"
                />
            </PlayerFormField>
            {preset === "custom" && (
                <PlayerFormField label="Minutes" error={error}>
                    <Input
                        autoFocus
                        type="number"
                        min={1}
                        max={MAX_TIMEOUT_MINUTES}
                        value={custom}
                        onChange={(event) => setCustom(event.target.value)}
                    />
                </PlayerFormField>
            )}
            <PlayerFormField label="Reason (shown to them)">
                <Input
                    value={reason}
                    maxLength={200}
                    placeholder="Optional"
                    onChange={(event) => setReason(event.target.value)}
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
    onClose,
    onChanged
}: {
    installedAppId: string;
    player: string;
    /** False for a viewer who may look and not touch, and on Bedrock, whose
     *  commands cannot answer this at all. */
    canEdit: boolean;
    onClose: () => void;
    /** The screen behind lists what is waiting to reach this player too, so a
     *  write that lands in that queue has to ask it to read the list again. */
    onChanged: () => void;
}) {
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto">
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
                    onChanged={onChanged}
                />
                <div className="flex justify-end">
                    <Button variant="ghost" onClick={onClose}>
                        Close
                    </Button>
                </div>
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
                            <dt className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{axis}</dt>
                            <dd className="font-mono text-lg tabular-nums">{coordinates.split(" ")[index]}</dd>
                        </div>
                    ))}
                </dl>
                <CopyButton value={coordinates} label={`${player}'s coordinates`} className="size-8" />
            </div>
            <p className="text-xs text-muted-foreground">
                {position.dimension ? dimensionLabel(position.dimension) : "World not reported"} - exactly{" "}
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
function useServerRead<T extends { error?: string }>(read: () => Promise<T>): {
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
                <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={onRefresh} disabled={loading}>
                        <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
                        Refresh
                    </Button>
                    <Button variant="ghost" onClick={onClose}>
                        Close
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** When somebody arrived and when they left, newest first, as far back as the
 *  server's log still reaches. */
export function HistoryDialog({
    player,
    sessions,
    registered = [],
    onClose,
    onRegister
}: {
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

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{player} on this server</DialogTitle>
                    <DialogDescription>
                        Read from the server&apos;s log, so it reaches back as far as the log does.
                    </DialogDescription>
                </DialogHeader>
                {newestFirst.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                        Nothing in the log this far back.
                    </p>
                ) : (
                    <ul className="max-h-80 divide-y divide-border overflow-y-auto text-sm">
                        {newestFirst.map((event, index) => (
                            <li
                                key={`${event.at ?? "unknown"}-${event.kind}-${index}`}
                                className="flex items-center justify-between gap-3 py-1.5"
                            >
                                <span className={event.kind === "join" ? "text-success" : "text-muted-foreground"}>
                                    {event.kind === "join" ? "Joined" : "Left"}
                                </span>
                                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                                    {event.address && <span className="font-mono">{event.address}</span>}
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
                                    <span>{event.at ? new Date(event.at).toLocaleString() : "time not logged"}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                <div className="flex justify-end">
                    <Button variant="ghost" onClick={onClose}>
                        Close
                    </Button>
                </div>
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
    onLookUp
}: {
    edition: MinecraftEdition;
    /** The player being edited, or null to register somebody new. */
    player: { username: string; addresses: readonly string[]; note: string | null } | null;
    pending: boolean;
    error: string | null;
    onClose: () => void;
    onSave: (input: { username: string; address: string; note: string }) => void;
    onRemoveAddress?: (address: string) => void;
    /** Find somebody by their Polaris name and hand back the Minecraft username
     *  they linked, plus the addresses their account is signed in from. Absent on
     *  a screen where nobody may look people up. */
    onLookUp?: (
        query: string
    ) => Promise<{ username?: string; name?: string; addresses?: string[]; error?: string }>;
}) {
    const editing = player !== null;
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

    /** Fill the name in from a Polaris account, spelled the way Mojang spells it. */
    function lookUp(query: string): void {
        const identifier = query.trim();
        if (!onLookUp || identifier.length === 0) return;
        setLookUpError(null);
        startLooking(async () => {
            const found = await onLookUp(identifier);
            if (found.error || !found.username) {
                setLookUpError(found.error ?? "Could not look that up");
                setSuggested([]);
                return;
            }
            setUsername(found.username);
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

    const name = username.trim();
    const rule = address.trim();
    // Only the addresses that would change something: one already in the field,
    // or already registered to this player, is not an offer.
    const offer = suggested.filter((known) => known !== rule && !(player?.addresses ?? []).includes(known));
    const nameInvalid = name.length > 0 && !isPlayerName(edition, name);
    const addressInvalid = rule.length > 0 && !isAddressRule(rule);
    // Editing without touching the address is how a note is changed; the note is
    // stored against a rule, so the one they already have carries it.
    const noteChanged = editing && note.trim() !== (player.note ?? "");
    const ready = editing
        ? (isAddressRule(rule) || (rule.length === 0 && noteChanged && player.addresses.length > 0))
        : isPlayerName(edition, name) && isAddressRule(rule);

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

    return (
        <PlayerFormDialog
            title={editing ? `Edit ${player.username}` : "Add a player"}
            description={
                editing
                    ? "Add another address they play from, or change the note. The name itself is what the server checks."
                    : "A player is let in when the name is on this list and they arrive from an address registered to it."
            }
            confirmLabel={editing ? "Save" : "Add player"}
            ready={ready}
            pending={pending}
            error={error}
            onClose={onClose}
            onConfirm={() =>
                onSave({
                    username: editing ? player.username : name,
                    address: rule.length > 0 ? rule : (player?.addresses[0] ?? ""),
                    note: note.trim()
                })
            }
        >
            {!editing && onLookUp && (
                <PlayerFormField
                    label="Somebody with a Polaris account"
                    error={lookUpError}
                    hint="If they have linked Minecraft, their name and the addresses they connect from fill themselves in."
                >
                    <div className="flex items-center gap-1">
                        <AccountInput
                            autoFocus
                            value={person}
                            onValueChange={setPerson}
                            // Choosing somebody off the list is the errand, so it
                            // is not also worth a button press. A name that was
                            // typed rather than picked still is.
                            onPick={(account) => lookUp(account.username || account.email)}
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
                            aria-label="Find their Minecraft account"
                            title="Find their Minecraft account"
                        >
                            {looking ? <Loader2 className="size-4 animate-spin" /> : <UserSearch className="size-4" />}
                        </Button>
                    </div>
                </PlayerFormField>
            )}

            <PlayerFormField
                label={edition === "bedrock" ? "Gamertag" : "Username"}
                error={nameInvalid ? "That is not a username this edition accepts" : null}
            >
                <Input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder={edition === "bedrock" ? "Gamertag" : "Username"}
                    disabled={editing}
                    aria-label="Player"
                />
            </PlayerFormField>

            {editing && player.addresses.length > 0 && (
                <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">Addresses they play from</span>
                    <div className="flex flex-wrap gap-1">
                        {player.addresses.map((held) => (
                            <span
                                key={held}
                                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
                            >
                                {held}
                                {onRemoveAddress && (
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
                        autoFocus={editing}
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
                        {detecting ? <Loader2 className="size-4 animate-spin" /> : <Locate className="size-4" />}
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

            <PlayerFormField label="Note" hint="Who this is, for whoever reads the list next. Only Polaris sees it.">
                <Input
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Who this is"
                    maxLength={120}
                    aria-label="Note"
                />
            </PlayerFormField>
        </PlayerFormDialog>
    );
}
