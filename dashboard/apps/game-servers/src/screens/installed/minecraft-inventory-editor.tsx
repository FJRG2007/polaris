"use client";

/**
 * A player's bag, and everything done to one.
 *
 * Looking at what somebody is carrying and handing them something used to be two
 * screens, which is two screens for one question: an operator giving an item wants
 * to see whether there is room and what it is meant to go with, and an operator
 * looking at a bag reaches for the palette the moment they see what is missing.
 * So this is the one panel - the grid, the palette beside it, and give and take
 * as the two directions of the same thing.
 *
 * The bag moves. The player is standing in it while somebody drags things around,
 * so it is re-read every couple of seconds - except mid-drag, because a grid that
 * reshuffles under the cursor drops the wrong item - and every write says what it
 * believed it was moving. A stale drag is refused rather than applied to whatever
 * is there now.
 *
 * The bag is often not there at all. A player who logged off has no live
 * inventory, so what is shown is the last copy Polaris kept, and this says so
 * plainly instead of drawing the same picture in both cases. What cannot happen
 * now is written down: an item dropped onto a slot stays on that slot, faded,
 * until they next join and it is really theirs.
 */

import * as actions from "./minecraft-actions";
import { type GameText, useGameText, useSchemaText } from "../game-text";
import { ItemPicker } from "./minecraft-item-picker";
import { InventoryExportMenu, InventoryImportButton } from "./minecraft-inventory-transfer";
import { bySlot } from "../../lib/minecraft/inventory";
import { Badge, Button, Input, Select, Skeleton, cn } from "@polaris/ui";
import { maxStackFor, stacksFor } from "../../lib/minecraft/items";
import { InventoryGrid, type PendingStack } from "./minecraft-inventory";
import { isMovable, writableSlots } from "../../lib/minecraft/item-argument";
import type { QueuedAction } from "../../lib/minecraft/queue";
import { describeQueuedText } from "./queue-text";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
    Eraser,
    Loader2,
    PackageMinus,
    PackagePlus,
    RefreshCw,
    Send,
    Trash2,
    X
} from "lucide-react";
import { hostUi } from "@polaris/app-host/client";

const { useDisplayFormat } = hostUi.displayFormat;
const { useConfirm } = hostUi.confirmDialog;

/** A bag's worth: 36 slots of 64, which is everything a player can hold. */
const MOST_THAT_FITS = 2304;

/** How often the bag is re-read while the editor is open and the player is on. */
const POLL_MS = 2000;

/** The same, for a bag big enough that reading it costs a round trip per stack.
 *  Forty questions every two seconds is a poll that competes with the game. */
const SLOW_POLL_MS = 8000;

/** What is being dragged: a slot already in the bag, or an item from the palette. */
type Held =
    | { readonly kind: "slot"; readonly slot: number }
    | { readonly kind: "palette"; readonly id: string };

export function InventoryEditor({
    installedAppId,
    player,
    editable,
    others = [],
    onChanged
}: {
    installedAppId: string;
    player: string;
    /** Everybody else who is on the server right now: who a stack can be sent to. */
    others?: readonly string[];
    /** False on Bedrock, which answers no `data get`: nothing to read back and no
     *  slot to write, though items can still be given and taken. */
    editable: boolean;
    /** Tell the screen behind that something was written down, so its own list of
     *  what is waiting agrees with this one. */
    onChanged: () => void;
}) {
    const schemaText = useSchemaText();
    const t = useGameText("minecraft");
    const display = useDisplayFormat();
    const [reading, setReading] = useState<actions.InventoryReading | null>(null);
    const [waiting, setWaiting] = useState<QueuedAction[]>([]);
    const [unread, setUnread] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [held, setHeld] = useState<Held | null>(null);
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState<string | null>(null);
    const [amount, setAmount] = useState(1);
    const [recent, setRecent] = useState<string[]>([]);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();
    /** Who a stack dropped on the send area goes to. */
    const [recipient, setRecipient] = useState<string | null>(null);
    // Read through a ref so the poll can see it without restarting on every drag.
    const dragging = useRef(false);
    dragging.current = held !== null;

    const items = reading?.items ?? [];
    const live = reading?.live ?? false;
    const slots = bySlot(items);

    const reload = useCallback(async () => {
        const result = await actions.readPlayerInventoryAction(installedAppId, player);
        setLoading(false);
        // A bag that could not be read is not a dead end: the grid is drawn empty
        // and can still be given to, so the reason goes beside it rather than in
        // place of everything.
        setUnread(result.reading ? null : (result.error ?? null));
        if (result.reading) setReading(result.reading);
    }, [installedAppId, player]);

    /**
     * What is written down for this player and has not happened yet.
     *
     * Read here rather than handed down from the players screen, which reads it
     * on its own five-second poll: an item dropped onto a slot for somebody who
     * is offline is only visible as that waiting stack, and waiting a poll for it
     * to appear is the same empty square that made a saved drop look like a lost
     * one.
     */
    const readQueue = useCallback(async () => {
        const result = await actions.pendingActionsAction(installedAppId);
        setWaiting(
            result.pending.filter((entry) => entry.username.toLowerCase() === player.toLowerCase())
        );
    }, [installedAppId, player]);

    useEffect(() => {
        void reload();
        void readQueue();
    }, [reload, readQueue]);

    // What has been handed out here lately, so the palette opens on it. Read once:
    // it is a hint about where to start, not a live figure.
    useEffect(() => {
        let alive = true;
        void actions
            .recentItemsAction(installedAppId)
            .then((result) => alive && setRecent(result.items));
        return () => {
            alive = false;
        };
    }, [installedAppId]);

    const slowRead = reading?.chunked === true;
    useEffect(() => {
        if (!live) return;
        const timer = setInterval(
            () => {
                // Not while something is in the air: the grid moving under the cursor
                // is how a drag ends on the slot next to the one somebody aimed at.
                if (!dragging.current && !pending) void reload();
            },
            slowRead ? SLOW_POLL_MS : POLL_MS
        );
        return () => clearInterval(timer);
    }, [live, pending, reload, slowRead]);

    /** The stacks waiting on a slot, which the grid draws in it, and everything
     *  else that is waiting, which is a line under it. */
    const queuedSlots: PendingStack[] = waiting.flatMap((entry) =>
        entry.payload.kind === "set-slot"
            ? [
                  {
                      id: entry.id,
                      slot: entry.payload.slot,
                      item: entry.payload.item,
                      count: entry.payload.count
                  }
              ]
            : []
    );
    const queuedElsewhere = waiting.filter((entry) => entry.payload.kind !== "set-slot");

    function run(work: () => Promise<{ error?: string; queued?: true; note?: string }>): void {
        setError(null);
        setNote(null);
        startTransition(async () => {
            const result = await work();
            if (result.error) {
                setError(result.error);
                return;
            }
            if (result.queued) setNote(t("inventoryEditor.queuedNote", { name: player }));
            else if (result.note) setNote(schemaText(result.note) ?? null);
            await Promise.all([reload(), readQueue()]);
            // The screen behind lists what is waiting too, and it only reads that
            // on its own poll.
            onChanged();
        });
    }

    /**
     * Put the chosen item in one slot, and the rest of the amount in the bag.
     *
     * A slot holds one stack, so asking for 128 is asking for one stack where the
     * cursor went and another 64 wherever they fit. Capping it at the slot's worth
     * silently dropped the difference - a number typed and then ignored.
     */
    async function putInSlot(id: string, slot: number): Promise<{ error?: string; queued?: true }> {
        const [first, ...rest] = stacksFor(id, amount);
        if (first === undefined) return {};
        const placed = await actions.setInventorySlotAction({
            installedAppId,
            player,
            slot,
            item: id,
            count: first
        });
        if (placed.error || rest.length === 0) return placed;
        const spare = rest.reduce((sum, stack) => sum + stack, 0);
        const given = await actions.givePlayerItemAction({
            installedAppId,
            player,
            item: id,
            count: spare
        });
        if (given.error) return given;
        return placed;
    }

    function dropOn(slot: number, modifiers: { whole: boolean; single: boolean }): void {
        const carrying = held;
        setHeld(null);
        if (!carrying) return;

        if (carrying.kind === "palette") {
            run(() => putInSlot(carrying.id, slot));
            return;
        }
        if (carrying.slot === slot) return;
        const source = slots.get(carrying.slot) ?? null;
        if (!source) return;
        // Ctrl takes one off the stack, shift moves all of it, and a plain drop
        // does what the game does with a plain drag: the whole thing.
        const count = modifiers.single && source.count > 1 ? 1 : undefined;
        run(() =>
            actions.moveInventorySlotAction({
                installedAppId,
                player,
                from: carrying.slot,
                to: slot,
                expected: { from: source, to: slots.get(slot) ?? null },
                ...(count === undefined ? {} : { count })
            })
        );
    }

    /** Right-click, which the game splits a stack with. Into the first free slot,
     *  because there is no cursor to hold the other half on a web page. */
    function split(slot: number): void {
        const source = slots.get(slot);
        if (!source || source.count < 2 || source.data !== null) return;
        const free = writableSlots().find((candidate) => !slots.has(candidate));
        if (free === undefined) {
            setError(t("inventoryEditor.noFreeSlot"));
            return;
        }
        run(() =>
            actions.moveInventorySlotAction({
                installedAppId,
                player,
                from: slot,
                to: free,
                expected: { from: source, to: null },
                count: Math.floor(source.count / 2)
            })
        );
    }

    const stuck = items.filter((item) => !isMovable(item));
    // Somebody who left since the list was drawn is not somebody to send to.
    const sendTo = recipient !== null && others.includes(recipient) ? recipient : null;

    async function emptyAll(): Promise<void> {
        const agreed = await confirm({
            title: t("inventoryEditor.emptyTitle", { name: player }),
            description: live
                ? t("inventoryEditor.everythingTheyCarryGoesArmour")
                : t("inventoryEditor.everythingTheyCarryGoesWhen"),
            confirmLabel: t("inventoryEditor.emptyInventory"),
            danger: true
        });
        if (agreed) run(() => actions.clearPlayerInventoryAction({ installedAppId, player }));
    }

    async function sendAll(to: string): Promise<void> {
        const agreed = await confirm({
            title: t("inventoryEditor.sendAllTitle", { name: to }),
            description: t("inventoryEditor.sendAllBody", { from: player, to }),
            confirmLabel: t("inventoryEditor.sendEverything")
        });
        if (!agreed) return;
        run(async () => {
            const result = await actions.transferInventoryAction({
                installedAppId,
                from: player,
                to
            });
            if (result.error) return { error: result.error };
            const moved = result.moved ?? 0;
            const kept = result.kept ?? 0;
            return {
                note:
                    t("inventoryEditor.sent", { count: moved, to }) +
                    (kept > 0
                        ? ` ${t("inventoryEditor.stayed", { count: kept, from: player })}`
                        : "")
            };
        });
    }

    return (
        <div className="flex flex-col gap-4 lg:flex-row">
            {confirmElement}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={live ? "success" : undefined}>
                        {live ? t("inventoryEditor.live") : t("inventoryEditor.fromACopy")}
                    </Badge>
                    {!live && reading?.takenAt && (
                        <span
                            className="text-xs text-muted-foreground"
                            title={display.dateTime(reading.takenAt)}
                        >
                            {t("inventoryEditor.kept", { when: ago(t, reading.takenAt) })}
                        </span>
                    )}
                    {loading && (
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Loader2 className="size-3 animate-spin" />{" "}
                            {t("inventoryEditor.readingTheirBag")}
                        </span>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                        {reading ? (
                            <InventoryExportMenu
                                installedAppId={installedAppId}
                                players={player}
                                onMessage={(message) => {
                                    setNote(message.note ?? null);
                                    setError(message.error ?? null);
                                }}
                            />
                        ) : null}
                        {editable ? (
                            <InventoryImportButton
                                installedAppId={installedAppId}
                                into={player}
                                onDone={() => {
                                    setLoading(true);
                                    void reload();
                                    void readQueue();
                                    onChanged();
                                }}
                            />
                        ) : null}
                    </div>
                    <Button
                        size="icon"
                        variant="ghost"
                        disabled={loading || pending}
                        aria-label={t("inventoryEditor.readTheBagAgain")}
                        title={t("inventoryEditor.readTheBagAgain")}
                        onClick={() => {
                            setLoading(true);
                            void reload();
                            void readQueue();
                        }}
                    >
                        <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
                    </Button>
                </div>

                {!live && !loading && (
                    <p className="rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs">
                        <span className="font-medium">
                            {t("inventoryEditor.notOnServer", { name: player })}
                        </span>{" "}
                        {reading?.takenAt
                            ? t("inventoryEditor.lastCopyNote")
                            : t("inventoryEditor.noCopyNote")}
                    </p>
                )}

                {/* Nine to a row whatever it is drawn inside - a bag that reflows
                    to four columns is not the bag the operator is looking at in
                    game - so on a narrow screen the grid scrolls rather than the
                    dialog around it. */}
                <div className="overflow-x-auto">
                    <InventoryGrid
                        items={items}
                        pending={queuedSlots}
                        onCancelPending={(id) =>
                            run(() => actions.cancelQueuedActionAction(installedAppId, id))
                        }
                        {...(editable
                            ? {
                                  handlers: {
                                      onPick: (slot) =>
                                          setHeld(slot === null ? null : { kind: "slot", slot }),
                                      onDropAt: dropOn,
                                      ...(live ? { onSplit: split } : {}),
                                      dragging: held?.kind === "slot" ? held.slot : null
                                  }
                              }
                            : {})}
                    />
                </div>

                {editable && (
                    <p className="text-xs text-muted-foreground">
                        {live
                            ? t("inventoryEditor.dragAStackAnywhereBag")
                            : t("inventoryEditor.dragAnItemFromThe")}
                    </p>
                )}
                {(reading?.unreadable ?? 0) > 0 && (
                    // Named rather than silently absent: a grid one shulker short
                    // looks exactly like a complete one, and somebody checking what
                    // a player is carrying would believe it.
                    <p className="text-xs text-warning">
                        {t("inventoryEditor.unreadable", { count: reading?.unreadable ?? 0 })}
                    </p>
                )}
                {stuck.length > 0 && (
                    // Named rather than left as slots that silently refuse to be
                    // picked up, which reads as the page being broken.
                    <p className="text-xs text-muted-foreground">
                        {t("inventoryEditor.stuck", { count: stuck.length })}
                    </p>
                )}

                {queuedElsewhere.length > 0 && (
                    <div className="flex flex-col gap-1 rounded-md border border-border bg-surface/40 px-3 py-2">
                        <p className="text-xs font-medium">
                            {t("inventoryEditor.alsoWaiting", { name: player })}
                        </p>
                        <ul className="flex flex-col gap-0.5">
                            {queuedElsewhere.map((entry) => (
                                <li
                                    key={entry.id}
                                    className="flex items-center justify-between gap-2 text-xs"
                                >
                                    <span className="truncate text-muted-foreground">
                                        {describeQueuedText(t, entry)}
                                    </span>
                                    <button
                                        type="button"
                                        disabled={pending}
                                        title={t("inventoryEditor.cancelWhat", {
                                            what: describeQueuedText(t, entry)
                                        })}
                                        aria-label={t("playersTab.cancelFor", {
                                            what: describeQueuedText(t, entry),
                                            name: player
                                        })}
                                        className="shrink-0 text-muted-foreground transition-colors hover:text-danger"
                                        onClick={() =>
                                            run(() =>
                                                actions.cancelQueuedActionAction(
                                                    installedAppId,
                                                    entry.id
                                                )
                                            )
                                        }
                                    >
                                        <X className="size-3.5" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {unread && <p className="text-xs text-muted-foreground">{unread}</p>}
                {note && <p className="text-xs text-success">{note}</p>}
                {error && <p className="text-xs text-danger">{error}</p>}
            </div>

            <div className="flex w-full shrink-0 flex-col gap-2 lg:w-72">
                <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                    {t("inventoryEditor.items")}
                </span>
                {/* Dragged onto a slot rather than clicked into one: the whole
                    point of the grid is that the operator picks where it lands.
                    The two buttons under it are for when they do not care. */}
                <div className={cn("min-h-0 flex-1", pending && "pointer-events-none opacity-60")}>
                    <ItemPicker
                        installedAppId={installedAppId}
                        value={picked}
                        query={query}
                        recent={recent}
                        onQueryChange={setQuery}
                        onSelect={setPicked}
                        {...(editable
                            ? {
                                  onDragItem: (id) =>
                                      setHeld(id === null ? null : { kind: "palette", id })
                              }
                            : {})}
                    />
                </div>

                <div className="flex items-center gap-2">
                    <Input
                        type="number"
                        min={1}
                        max={MOST_THAT_FITS}
                        value={amount}
                        aria-label={t("inventoryEditor.howMany")}
                        className="w-20"
                        onChange={(event) =>
                            setAmount(
                                Math.max(
                                    1,
                                    Math.min(MOST_THAT_FITS, Number(event.target.value) || 1)
                                )
                            )
                        }
                    />
                    <span className="text-xs text-muted-foreground">
                        {t("inventoryEditor.atATime")}
                    </span>
                </div>
                {picked && amount > maxStackFor(picked) && (
                    <p className="text-xs text-muted-foreground">
                        {t("inventoryEditor.manyStacks", {
                            count: stacksFor(picked, amount).length
                        })}
                    </p>
                )}

                <div className="flex flex-col gap-1.5">
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={!picked || pending}
                        onClick={() =>
                            picked &&
                            run(() =>
                                actions.givePlayerItemAction({
                                    installedAppId,
                                    player,
                                    item: picked,
                                    count: amount
                                })
                            )
                        }
                    >
                        <PackagePlus className="size-4" />
                        {live
                            ? t("inventoryEditor.giveItToThem")
                            : t("inventoryEditor.saveItForTheirNext")}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={!picked || pending}
                        className="text-danger hover:text-danger"
                        onClick={() =>
                            picked &&
                            run(() =>
                                actions.clearPlayerItemAction({
                                    installedAppId,
                                    player,
                                    item: picked,
                                    count: amount
                                })
                            )
                        }
                    >
                        <PackageMinus className="size-4" />
                        {live
                            ? t("inventoryEditor.takeItOffThem")
                            : t("inventoryEditor.takeItWhenTheyJoin")}
                    </Button>
                </div>
                {picked && editable && (
                    <p className="text-xs text-muted-foreground">
                        {live ? t("inventoryEditor.orDrag") : t("inventoryEditor.orDragToSave")}
                    </p>
                )}

                {editable && live && (
                    <div
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                            event.preventDefault();
                            const carrying = held;
                            setHeld(null);
                            if (carrying?.kind !== "slot") return;
                            run(() =>
                                actions.clearInventorySlotAction(
                                    installedAppId,
                                    player,
                                    carrying.slot
                                )
                            );
                        }}
                        className={cn(
                            "flex items-center justify-center gap-2 rounded-md border border-dashed px-3 py-3 text-xs transition-colors",
                            held?.kind === "slot"
                                ? "border-danger bg-danger-soft text-danger-ink"
                                : "border-border text-muted-foreground"
                        )}
                    >
                        <Trash2 className="size-4" />
                        {t("inventoryEditor.dropAStackHereTo")}
                    </div>
                )}

                {editable && live && (
                    <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                        <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                            {t("inventoryEditor.sendToAnotherPlayer")}
                        </span>
                        {others.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                                {t("inventoryEditor.nobodyElseIsOnThe")}
                            </p>
                        ) : (
                            <>
                                <Select
                                    aria-label={t("inventoryEditor.playerToSendTo")}
                                    placeholder={t("inventoryEditor.chooseAPlayer")}
                                    value={sendTo ?? ""}
                                    onValueChange={(value) => setRecipient(value || null)}
                                    options={others.map((name) => ({ value: name, label: name }))}
                                />
                                <div
                                    onDragOver={(event) => event.preventDefault()}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        const carrying = held;
                                        setHeld(null);
                                        if (carrying?.kind !== "slot" || !sendTo) return;
                                        const source = slots.get(carrying.slot) ?? null;
                                        run(() =>
                                            actions.transferStackAction({
                                                installedAppId,
                                                from: player,
                                                to: sendTo,
                                                slot: carrying.slot,
                                                expected: source
                                            })
                                        );
                                    }}
                                    className={cn(
                                        "flex items-center justify-center gap-2 rounded-md border border-dashed px-3 py-3 text-xs transition-colors",
                                        held?.kind === "slot" && sendTo
                                            ? "border-primary bg-primary/10 text-foreground"
                                            : "border-border text-muted-foreground"
                                    )}
                                >
                                    <Send className="size-4" />
                                    {sendTo
                                        ? t("inventoryEditor.dropToSend", { name: sendTo })
                                        : t("inventoryEditor.chooseAPlayerThenDrop")}
                                </div>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={!sendTo || pending || items.length === 0}
                                    onClick={() => sendTo && void sendAll(sendTo)}
                                >
                                    <Send className="size-4" />
                                    {sendTo
                                        ? t("inventoryEditor.sendAllTo", { name: sendTo })
                                        : t("inventoryEditor.sendEverything")}
                                </Button>
                            </>
                        )}
                    </div>
                )}

                <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending || (live && items.length === 0)}
                    className="text-danger hover:text-danger"
                    onClick={() => void emptyAll()}
                >
                    <Eraser className="size-4" />
                    {live
                        ? t("inventoryEditor.emptyInventory")
                        : t("inventoryEditor.emptyItWhenTheyJoin")}
                </Button>
                {pending && <Skeleton className="h-1 w-full" />}
            </div>
        </div>
    );
}

/** "6 minutes ago", in the words somebody reads a staleness warning in. */
function ago(t: GameText<"minecraft">, iso: string): string {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 90) return t("inventoryEditor.ago.moment");
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t("inventoryEditor.ago.minutes", { count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t("inventoryEditor.ago.hours", { count: hours });
    return t("inventoryEditor.ago.days", { count: Math.round(hours / 24) });
}
