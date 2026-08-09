"use client";

/**
 * A player's bag, as something an operator can rearrange.
 *
 * The grid is the one the read-only view uses - same layout, same slots - with
 * the handlers that make it draggable. Everything else here is about the two
 * things a screen like this gets wrong:
 *
 * The bag moves. The player is standing in it while somebody drags things
 * around, so it is re-read every couple of seconds - except mid-drag, because a
 * grid that reshuffles under the cursor drops the wrong item - and every write
 * says what it believed it was moving. A stale drag is refused rather than
 * applied to whatever is there now.
 *
 * The bag is often not there at all. A player who logged off has no live
 * inventory, so what is shown is the last copy Polaris kept, and this says so
 * plainly instead of drawing the same picture in both cases. What can still be
 * done then is queued: dropping an item from the palette onto a slot writes a
 * decision that lands when they next join.
 */

import { ItemPicker } from "./minecraft-item-picker";
import { InventoryGrid } from "./minecraft-inventory";
import { bySlot } from "@/lib/apps/minecraft/inventory";
import { maxStackFor, stacksFor } from "@/lib/apps/minecraft/items";

/** A bag's worth: 36 slots of 64, which is everything a player can hold. */
const MOST_THAT_FITS = 2304;
import { useDisplayFormat } from "@/components/display-format";
import { Badge, Button, Input, Skeleton, cn } from "@polaris/ui";
import { isMovable, writableSlots } from "@/lib/apps/minecraft/item-argument";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
    clearInventorySlotAction,
    givePlayerItemAction,
    moveInventorySlotAction,
    readPlayerInventoryAction,
    recentItemsAction,
    setInventorySlotAction,
    type InventoryReading
} from "./minecraft-actions";

/** How often the bag is re-read while the editor is open and the player is on. */
const POLL_MS = 2000;

/** What is being dragged: a slot already in the bag, or an item from the palette. */
type Held = { readonly kind: "slot"; readonly slot: number } | { readonly kind: "palette"; readonly id: string };

export function InventoryEditor({
    installedAppId,
    player,
    reading,
    onReloaded
}: {
    installedAppId: string;
    player: string;
    /** The first reading, from whoever opened this. */
    reading: InventoryReading;
    onReloaded?: (reading: InventoryReading) => void;
}) {
    const display = useDisplayFormat();
    const [current, setCurrent] = useState(reading);
    const [held, setHeld] = useState<Held | null>(null);
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState<string | null>(null);
    const [amount, setAmount] = useState(1);
    const [recent, setRecent] = useState<string[]>([]);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    // Read through a ref so the poll can see it without restarting on every drag.
    const dragging = useRef(false);
    dragging.current = held !== null;

    const live = current.live;
    const slots = bySlot(current.items);

    const reload = useCallback(async () => {
        const result = await readPlayerInventoryAction(installedAppId, player);
        if (result.reading) {
            setCurrent(result.reading);
            onReloaded?.(result.reading);
        }
    }, [installedAppId, player, onReloaded]);

    // What has been handed out here lately, so the palette opens on it. Read once:
    // it is a hint about where to start, not a live figure.
    useEffect(() => {
        let alive = true;
        void recentItemsAction(installedAppId).then((result) => alive && setRecent(result.items));
        return () => {
            alive = false;
        };
    }, [installedAppId]);

    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => {
            // Not while something is in the air: the grid moving under the cursor
            // is how a drag ends on the slot next to the one somebody aimed at.
            if (!dragging.current && !pending) void reload();
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [live, pending, reload]);

    function run(work: () => Promise<{ error?: string; queued?: true }>): void {
        setError(null);
        setNote(null);
        startTransition(async () => {
            const result = await work();
            if (result.error) {
                setError(result.error);
                return;
            }
            if (result.queued) setNote(`Saved. It happens when ${player} next joins.`);
            await reload();
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
        const placed = await setInventorySlotAction({ installedAppId, player, slot, item: id, count: first });
        if (placed.error || rest.length === 0) return placed;
        const spare = rest.reduce((sum, stack) => sum + stack, 0);
        const given = await givePlayerItemAction({ installedAppId, player, item: id, count: spare });
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
            moveInventorySlotAction({
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
            setError("There is no free slot to split it into.");
            return;
        }
        run(() =>
            moveInventorySlotAction({
                installedAppId,
                player,
                from: slot,
                to: free,
                expected: { from: source, to: null },
                count: Math.floor(source.count / 2)
            })
        );
    }

    const stuck = current.items.filter((item) => !isMovable(item));

    return (
        <div className="flex flex-col gap-4 lg:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                {!live && (
                    <p className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
                        <span className="font-medium">{player} is not on the server.</span>{" "}
                        {current.takenAt ? (
                            <>
                                This is the last copy Polaris kept, from{" "}
                                <span title={display.dateTime(current.takenAt)}>{ago(current.takenAt)}</span>. Nothing
                                in it can be moved,
                            </>
                        ) : (
                            <>
                                Polaris has no copy of their bag yet - one is kept every ten minutes while they play -
                                so it is drawn empty. Nothing can be moved out of it,
                            </>
                        )}{" "}
                        but an item dropped in from the palette is saved and given to them when they join.
                    </p>
                )}

                <InventoryGrid
                    items={current.items}
                    handlers={{
                        onPick: (slot) => setHeld(slot === null ? null : { kind: "slot", slot }),
                        onDropAt: dropOn,
                        ...(live ? { onSplit: split } : {}),
                        dragging: held?.kind === "slot" ? held.slot : null
                    }}
                />

                {live && (
                    <p className="text-xs text-muted-foreground">
                        Drag to move a stack. Hold Ctrl to move one of it, and right-click to split it in half.
                    </p>
                )}
                {stuck.length > 0 && (
                    // Named rather than left as slots that silently refuse to be
                    // picked up, which reads as the page being broken.
                    <p className="text-xs text-muted-foreground">
                        {stuck.length} {stuck.length === 1 ? "stack carries" : "stacks carry"} data Polaris cannot
                        write back exactly, so {stuck.length === 1 ? "it cannot" : "they cannot"} be moved without
                        losing it.
                    </p>
                )}
                {note && <p className="text-xs text-success">{note}</p>}
                {error && <p className="text-xs text-danger">{error}</p>}
            </div>

            <div className="flex w-full shrink-0 flex-col gap-2 lg:w-72">
                <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">Give an item</span>
                <div className="flex items-center gap-2">
                    <Input
                        type="number"
                        min={1}
                        max={MOST_THAT_FITS}
                        value={amount}
                        aria-label="How many to give"
                        className="w-20"
                        onChange={(event) =>
                            setAmount(Math.max(1, Math.min(MOST_THAT_FITS, Number(event.target.value) || 1)))
                        }
                    />
                    <span className="text-xs text-muted-foreground">at a time</span>
                </div>
                {picked && amount > maxStackFor(picked) && (
                    <p className="text-xs text-muted-foreground">
                        {stacksFor(picked, amount).length} stacks. One lands where you drop it and the rest go into the
                        bag.
                    </p>
                )}
                {/* Dragged onto a slot rather than clicked into one: the whole
                    point of the grid is that the operator picks where it lands. */}
                <div className={cn("min-h-0 flex-1", pending && "pointer-events-none opacity-60")}>
                    <ItemPicker
                        value={picked}
                        query={query}
                        recent={recent}
                        onQueryChange={setQuery}
                        onSelect={setPicked}
                        onDragItem={(id) => setHeld(id === null ? null : { kind: "palette", id })}
                    />
                </div>
                {picked && (
                    <p className="text-xs text-muted-foreground">
                        Drag {picked} onto a slot{live ? "" : " to save it for their next join"}.
                    </p>
                )}
                {live && picked && (
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={pending}
                        onClick={() => {
                            const free = writableSlots().find((candidate) => !slots.has(candidate));
                            if (free === undefined) {
                                setError("There is no free slot to put it in.");
                                return;
                            }
                            run(() => putInSlot(picked, free));
                        }}
                    >
                        Put it in the first free slot
                    </Button>
                )}
                {live && (
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending || held?.kind !== "slot"}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                            event.preventDefault();
                            const carrying = held;
                            setHeld(null);
                            if (carrying?.kind !== "slot") return;
                            run(() => clearInventorySlotAction(installedAppId, player, carrying.slot));
                        }}
                        className="border border-dashed border-danger/40 text-danger"
                    >
                        Drop a stack here to take it away
                    </Button>
                )}
                {pending && <Skeleton className="h-1 w-full" />}
                <Badge className="w-fit">{live ? "Live" : "From a copy"}</Badge>
            </div>
        </div>
    );
}

/** "6 minutes ago", in the words somebody reads a staleness warning in. */
function ago(iso: string): string {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 90) return "a moment ago";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
    const days = Math.round(hours / 24);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
}
