"use client";

/**
 * Put the rows of an editable list in a different order, by dragging a row's
 * handle or with the arrow keys on it.
 *
 * Each row carries an id of its own rather than its position as its key: a text
 * field keyed by position keeps its caret and its undo history in the slot, so
 * after a move the text would jump rows while the field stayed put.
 *
 * Native drag and drop, armed only from the handle, so pressing into one of the
 * row's text fields to select a word never picks the whole row up.
 *
 * The whole list is where a row can be let go, not only the rows themselves:
 * the gaps between them and the heading above the first are where a hand
 * naturally drops one, and letting go there used to do nothing - which read as
 * a row that cannot be put first.
 */

import { useCallback, useRef, useState, type DragEvent, type KeyboardEvent } from "react";

/** A list of `from` moved to sit at `to`, everything else in its order. */
export function moved<T>(items: readonly T[], from: number, to: number): T[] {
    if (from === to || from < 0 || from >= items.length) return [...items];
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, item as T);
    return next;
}

export function useListOrder(count: number, onMove: (from: number, to: number) => void) {
    const nextId = useRef(0);
    const make = () => {
        nextId.current += 1;
        return nextId.current;
    };
    const [ids, setIds] = useState<number[]>(() => Array.from({ length: count }, make));
    const [armed, setArmed] = useState<number | null>(null);
    const [dragging, setDragging] = useState<number | null>(null);
    /** Where the dragged row would land: before this index. */
    const [dropAt, setDropAt] = useState<number | null>(null);
    const handles = useRef(new Map<number, HTMLElement>());
    const rows = useRef(new Map<number, HTMLElement>());

    /** Where a row let go at this height lands: before the first row whose
     *  middle is below it, or at the end. */
    const landingAt = (y: number) => {
        let at = 0;
        for (const [index, row] of rows.current) {
            const box = row.getBoundingClientRect();
            if (y > box.top + box.height / 2) at = Math.max(at, index + 1);
        }
        return at;
    };

    /** New ids for a list that was replaced as a whole - loaded, or saved back. */
    const reset = useCallback((length: number) => setIds(Array.from({ length }, make)), []);
    const added = useCallback(() => setIds((current) => [...current, make()]), []);
    const removed = useCallback((index: number) => setIds((current) => current.filter((_, at) => at !== index)), []);

    const move = (from: number, to: number) => {
        if (from === to) return;
        const id = ids[from];
        setIds((current) => moved(current, from, to));
        onMove(from, to);
        // The handle that was used keeps the focus in its new place, so the arrow
        // keys can go on moving the same row.
        if (id !== undefined) requestAnimationFrame(() => handles.current.get(id)?.focus());
    };

    const end = () => {
        setArmed(null);
        setDragging(null);
        setDropAt(null);
    };

    /** Spread on the element around the rows - and around whatever sits over
     *  the first of them, so letting go there puts a row first. */
    const listProps = {
        onDragOver: (event: DragEvent<HTMLElement>) => {
            if (dragging === null) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropAt(landingAt(event.clientY));
        },
        onDrop: (event: DragEvent) => {
            if (dragging === null) return;
            event.preventDefault();
            // Read where it was let go rather than the last place it was over:
            // the two differ by however far the last move went.
            const at = landingAt(event.clientY);
            // Landing below itself counts the gap it leaves behind.
            move(dragging, at > dragging ? at - 1 : at);
            end();
        }
    };

    /** Spread on the row. */
    const rowProps = (index: number) => ({
        ref: (element: HTMLElement | null) => {
            if (element) rows.current.set(index, element);
            else rows.current.delete(index);
        },
        draggable: armed === index,
        onDragStart: (event: DragEvent) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", String(index));
            setDragging(index);
        },
        onDragEnd: end
    });

    /** Spread on the handle. */
    const handleProps = (index: number, total: number) => ({
        ref: (element: HTMLElement | null) => {
            const id = ids[index];
            if (id === undefined) return;
            if (element) handles.current.set(id, element);
            else handles.current.delete(id);
        },
        onPointerDown: () => setArmed(index),
        onPointerUp: () => setArmed(null),
        onKeyDown: (event: KeyboardEvent) => {
            if (event.key === "ArrowUp" && index > 0) {
                event.preventDefault();
                move(index, index - 1);
            } else if (event.key === "ArrowDown" && index < total - 1) {
                event.preventDefault();
                move(index, index + 1);
            }
        }
    });

    return { ids, reset, added, removed, listProps, rowProps, handleProps, dragging, dropAt };
}
