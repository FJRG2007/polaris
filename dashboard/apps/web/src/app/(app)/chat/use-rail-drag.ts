"use client";

/**
 * Dragging the rail into the shape somebody wants.
 *
 * Channels move within a heading, between headings, and out from under all of
 * them; headings move among themselves. Only somebody who administers the space
 * can do any of it, and the server checks that again - this decides what is
 * draggable, not what is allowed.
 *
 * The hook holds the drag and nothing else. Where a dropped thing belongs in a
 * list is the rail's business, because the rail is what holds the list; all this
 * reports is what was picked up and what it was let go over. That split is why
 * there is no list logic here to disagree with the list on screen.
 *
 * The drop line goes above or below the row under the pointer depending on which
 * half of it the pointer is in. Without that there is no way to put a channel at
 * the very bottom of a heading.
 */

import type { DragEvent } from "react";
import { useCallback, useRef, useState } from "react";

/** What is being dragged. */
export interface Dragging {
    readonly kind: "channel" | "category";
    readonly id: string;
}

/** Where the pointer is, so a line can be drawn there. */
export interface DropAt {
    readonly kind: "channel" | "category";
    readonly id: string;
    /** Below the row rather than above it. */
    readonly after: boolean;
}

/** Where something was let go. */
export type DropTarget =
    | { readonly at: "row"; readonly id: string; readonly after: boolean }
    /** Past the last row of a heading, or into an empty one. */
    | { readonly at: "end"; readonly categoryId: string | null };

export function useRailDrag({
    enabled,
    onDrop
}: {
    enabled: boolean;
    onDrop: (source: Dragging, target: DropTarget) => void;
}) {
    const [dragging, setDragging] = useState<Dragging | null>(null);
    const [dropAt, setDropAt] = useState<DropAt | null>(null);
    // Both read inside handlers that run before React has re-rendered, so the
    // state from this render can be a pointer move behind what is on screen.
    const held = useRef<Dragging | null>(null);
    const over = useRef<DropAt | null>(null);

    const finish = useCallback(() => {
        held.current = null;
        over.current = null;
        setDragging(null);
        setDropAt(null);
    }, []);

    /** What can be picked up. */
    const handleProps = useCallback(
        (item: Dragging) => ({
            draggable: enabled,
            onDragStart: (event: DragEvent) => {
                if (!enabled) return;
                held.current = item;
                setDragging(item);
                event.dataTransfer.effectAllowed = "move";
                // Some browsers refuse to start a drag with nothing on it.
                event.dataTransfer.setData("text/plain", item.id);
            },
            onDragEnd: finish
        }),
        [enabled, finish]
    );

    /** One row, as something to drop onto. */
    const rowProps = useCallback(
        (kind: Dragging["kind"], id: string) => ({
            onDragOver: (event: DragEvent) => {
                const source = held.current;
                // A heading is never dropped among channels, nor the reverse.
                if (!source || source.kind !== kind || source.id === id) return;
                event.preventDefault();
                event.stopPropagation();
                const box = event.currentTarget.getBoundingClientRect();
                const next = { kind, id, after: event.clientY > box.top + box.height / 2 };
                over.current = next;
                setDropAt(next);
            },
            onDragLeave: () => {
                if (over.current?.id !== id) return;
                over.current = null;
                setDropAt(null);
            },
            onDrop: (event: DragEvent) => {
                const source = held.current;
                const where = over.current;
                if (!source || source.kind !== kind || source.id === id) {
                    finish();
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                finish();
                onDrop(source, { at: "row", id, after: where?.after ?? false });
            }
        }),
        [finish, onDrop]
    );

    /** A heading's whole area, so an empty one and the space past the last row
     *  are both places a channel can land. */
    const areaProps = useCallback(
        (categoryId: string | null) => ({
            onDragOver: (event: DragEvent) => {
                if (held.current?.kind !== "channel") return;
                event.preventDefault();
            },
            onDrop: (event: DragEvent) => {
                const source = held.current;
                finish();
                if (source?.kind !== "channel") return;
                event.preventDefault();
                onDrop(source, { at: "end", categoryId });
            }
        }),
        [finish, onDrop]
    );

    return { dragging, dropAt, handleProps, rowProps, areaProps };
}

/**
 * The list with `id` taken out and put back where the drop says.
 *
 * Shared by both kinds because it is the same operation over two lists, and
 * because getting "moved down within the same list" right - the index shifts
 * once the item is removed - is the sort of thing that should exist once.
 */
export function reordered(ids: readonly string[], id: string, target: DropTarget): string[] {
    // Dropped on itself. The menu never asks for this, but the answer has to be
    // "nothing changed" rather than "taken out and put on the end", which is
    // what removing it first and then looking for it would produce.
    if (target.at === "row" && target.id === id) return [...ids];
    const without = ids.filter((entry) => entry !== id);
    if (target.at === "end") return [...without, id];
    const at = without.indexOf(target.id);
    if (at === -1) return [...without, id];
    without.splice(target.after ? at + 1 : at, 0, id);
    return without;
}
