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
 * The two that read rather than change - what somebody is carrying, where they
 * are standing - share their states, because a refresh that behaved differently
 * between them would be a difference nobody could see the reason for.
 */

import * as actions from "./minecraft-actions";
import { ItemPicker } from "./minecraft-item-picker";
import { InventoryGrid } from "./minecraft-inventory";
import { CopyButton } from "@/components/copy-button";
import { useCallback, useEffect, useState } from "react";
import { typedItemId } from "@/lib/apps/minecraft/items";
import { MAX_TIMEOUT_MINUTES } from "@/lib/apps/minecraft/timeout";
import type { PlayerSessionEvent } from "@/lib/apps/minecraft/sessions";
import { Backpack, Loader2, MapPin, RefreshCw, TriangleAlert } from "lucide-react";
import { dimensionLabel, formatCoordinates, type PlayerPosition } from "@/lib/apps/minecraft/position";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Select } from "@polaris/ui";

/** Which of the forms is open, or none. */
export type PlayerDialog = "give" | "teleport" | "timeout" | "inventory" | "location" | "history";

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

export function GiveItemDialog({
    player,
    pending,
    onClose,
    onGive
}: {
    player: string;
    pending: boolean;
    onClose: () => void;
    onGive: (item: string, count: number) => void;
}) {
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState<string | null>(null);
    const [count, setCount] = useState("1");
    const parsedCount = Number.parseInt(count, 10);
    // A written-out id counts as a choice, so an operator who knows exactly what
    // they want can type it and press Enter. Half a word on the way to one does
    // not: `minecraft:swor` is a well-formed id and no item at all.
    const item = picked ?? typedItemId(query);
    const countError =
        !Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > 64 ? "Between 1 and 64" : null;

    return (
        <Shell
            size="md"
            title={`Give ${player} an item`}
            description="It goes straight into their inventory, or drops at their feet when there is no room."
            onClose={onClose}
            pending={pending}
            ready={item !== null && !countError && !pending}
            confirmLabel="Give"
            onConfirm={() => item !== null && onGive(item, parsedCount)}
        >
            <ItemPicker
                value={item}
                query={query}
                onQueryChange={(next) => {
                    setQuery(next);
                    // Typing again is somebody looking for something else; keeping
                    // the old tile selected would hand out the previous item.
                    setPicked(null);
                }}
                onSelect={setPicked}
            />
            <Field label="How many" error={countError}>
                <Input
                    type="number"
                    min={1}
                    max={64}
                    value={count}
                    onChange={(event) => setCount(event.target.value)}
                />
            </Field>
        </Shell>
    );
}

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
        <Shell
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
            <Field label="Player or coordinates" error={error}>
                <Input
                    autoFocus
                    value={destination}
                    spellCheck={false}
                    placeholder="Alice, or 100 64 -220"
                    onChange={(event) => setDestination(event.target.value)}
                />
            </Field>
        </Shell>
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
        <Shell
            title={`Time ${player} out`}
            description="They are banned now and let back in when it runs out, without anybody having to remember."
            onClose={onClose}
            pending={pending}
            ready={!error && !pending}
            confirmLabel="Time out"
            danger
            onConfirm={() => onTimeout(minutes, reason.trim())}
        >
            <Field label="How long">
                <Select
                    value={preset}
                    onValueChange={setPreset}
                    options={TIMEOUT_PRESETS}
                    aria-label="How long the timeout lasts"
                />
            </Field>
            {preset === "custom" && (
                <Field label="Minutes" error={error}>
                    <Input
                        autoFocus
                        type="number"
                        min={1}
                        max={MAX_TIMEOUT_MINUTES}
                        value={custom}
                        onChange={(event) => setCustom(event.target.value)}
                    />
                </Field>
            )}
            <Field label="Reason (shown to them)">
                <Input
                    value={reason}
                    maxLength={200}
                    placeholder="Optional"
                    onChange={(event) => setReason(event.target.value)}
                />
            </Field>
        </Shell>
    );
}

/**
 * What a player is carrying, in the shape the game keeps it.
 *
 * Read when the dialog opens rather than polled: an inventory changes constantly
 * and a grid that reshuffled under the operator reading it would be worse than
 * one they refresh when they want to - so there is a button that does.
 *
 * The install is named rather than handed a reader, because the screen behind
 * this polls: a closure passed down would be a new function on every tick and the
 * read would fire again with it, once every five seconds, unasked.
 */
export function InventoryDialog({
    installedAppId,
    player,
    onClose
}: {
    installedAppId: string;
    player: string;
    onClose: () => void;
}) {
    const read = useCallback(
        () => actions.readPlayerInventoryAction(installedAppId, player),
        [installedAppId, player]
    );
    const { data, error, loading, refresh } = useServerRead(read);
    const items = data?.items ?? null;

    return (
        <Reading
            title={`${player}'s inventory`}
            description="As the server has it right now."
            icon={<Backpack className="size-6" />}
            loadingLabel="Reading it from the server..."
            empty="Nothing in it."
            loading={loading}
            error={error}
            onRefresh={refresh}
            onClose={onClose}
        >
            {items && <InventoryGrid items={items} />}
        </Reading>
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

/** One read of the running server, with the states a read has. Shared because the
 *  inventory and the position are the same thing asked twice, and a refresh that
 *  behaved differently between them would be a bug nobody could see. */
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
    onClose
}: {
    player: string;
    sessions: readonly PlayerSessionEvent[];
    onClose: () => void;
}) {
    const newestFirst = [...sessions].reverse();

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

/** The frame the three forms share, so they agree about where the buttons are. */
function Shell({
    title,
    description,
    children,
    onClose,
    onConfirm,
    confirmLabel,
    ready,
    pending,
    danger,
    size = "sm"
}: {
    title: string;
    description: string;
    children: React.ReactNode;
    onClose: () => void;
    onConfirm: () => void;
    confirmLabel: string;
    ready: boolean;
    pending: boolean;
    danger?: boolean;
    /** Wider for the form that holds a grid of pictures rather than two fields. */
    size?: "sm" | "md";
}) {
    return (
        <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
            <DialogContent className={size === "md" ? "max-w-md" : "max-w-sm"}>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (ready) onConfirm();
                    }}
                >
                    {children}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                            Cancel
                        </Button>
                        <Button type="submit" variant={danger ? "danger" : "primary"} disabled={!ready}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            {confirmLabel}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function Field({
    label,
    error,
    children
}: {
    label: string;
    error?: string | null;
    children: React.ReactNode;
}) {
    return (
        <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs text-muted-foreground">{label}</span>
            {children}
            {error && <span className="text-xs text-danger">{error}</span>}
        </label>
    );
}
