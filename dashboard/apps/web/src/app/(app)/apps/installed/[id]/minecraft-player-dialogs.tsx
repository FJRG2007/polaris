"use client";

/**
 * The things you do to one player that need more than a click.
 *
 * Kept out of the table because they are all the same shape - name a player, ask
 * for one more thing, send a command - and a table that also holds five forms
 * stops being readable. Each one is opened from the row and answers about that
 * row only.
 *
 * Every field is checked here against the same rules the server action checks it
 * against, so a wrong item id says so before it is a failed command in the log.
 */

import { useEffect, useState } from "react";
import { Backpack, Loader2 } from "lucide-react";
import { MAX_TIMEOUT_MINUTES } from "@/lib/apps/minecraft/timeout";
import type { PlayerSessionEvent } from "@/lib/apps/minecraft/sessions";
import { slotLabel, type InventoryItem } from "@/lib/apps/minecraft/inventory";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Select } from "@polaris/ui";

/** Which of the forms is open, or none. */
export type PlayerDialog = "give" | "teleport" | "timeout" | "inventory" | "history";

/** Item ids as the game writes them; the same rule the action validates against. */
const ITEM_ID = /^(?:[a-z0-9_.-]+:)?[a-z0-9_.-]{1,64}$/;

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
    const [item, setItem] = useState("minecraft:");
    const [count, setCount] = useState("1");
    const parsedCount = Number.parseInt(count, 10);
    const itemError = item.trim().length > 0 && !ITEM_ID.test(item.trim()) ? "An item looks like minecraft:stone" : null;
    const countError =
        !Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > 64 ? "Between 1 and 64" : null;
    const ready = ITEM_ID.test(item.trim()) && !countError && !pending;

    return (
        <Shell
            title={`Give ${player} an item`}
            description="It goes straight into their inventory, or drops at their feet when there is no room."
            onClose={onClose}
            pending={pending}
            ready={ready}
            confirmLabel="Give"
            onConfirm={() => onGive(item.trim(), parsedCount)}
        >
            <Field label="Item" error={itemError}>
                <Input
                    autoFocus
                    value={item}
                    spellCheck={false}
                    placeholder="minecraft:diamond"
                    onChange={(event) => setItem(event.target.value)}
                />
            </Field>
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
 * What a player is carrying.
 *
 * Read when the dialog opens rather than polled: an inventory changes constantly
 * and a list that reshuffled under the operator reading it would be worse than
 * one they refresh when they want to.
 */
export function InventoryDialog({
    player,
    onClose,
    onRead
}: {
    player: string;
    onClose: () => void;
    onRead: () => Promise<{ items?: InventoryItem[]; error?: string }>;
}) {
    const [items, setItems] = useState<InventoryItem[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let live = true;
        setLoading(true);
        void onRead().then((result) => {
            if (!live) return;
            setLoading(false);
            if (result.error) setError(result.error);
            else setItems(result.items ?? []);
        });
        return () => {
            live = false;
        };
    }, [onRead]);

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{player}&apos;s inventory</DialogTitle>
                    <DialogDescription>As the server has it right now.</DialogDescription>
                </DialogHeader>
                {loading ? (
                    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" /> Reading it from the server...
                    </p>
                ) : error ? (
                    <p className="py-6 text-sm text-danger">{error}</p>
                ) : items && items.length > 0 ? (
                    <ul className="max-h-80 divide-y divide-border overflow-y-auto text-sm">
                        {items.map((item) => (
                            <li key={item.slot} className="flex items-center justify-between gap-3 py-1.5">
                                <span className="truncate font-mono text-xs" title={item.id}>
                                    {item.id.replace(/^minecraft:/, "")}
                                </span>
                                <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                                    <span>{slotLabel(item.slot)}</span>
                                    <span className="tabular-nums">x{item.count}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
                        <Backpack className="size-6" />
                        Nothing in it.
                    </p>
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
    danger
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
}) {
    return (
        <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
            <DialogContent className="max-w-sm">
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
