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

    /** Spread on the row. */
    const rowProps = (index: number) => ({
        draggable: armed === index,
        onDragStart: (event: DragEvent) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", String(index));
            setDragging(index);
        },
        onDragOver: (event: DragEvent<HTMLElement>) => {
            if (dragging === null) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const box = event.currentTarget.getBoundingClientRect();
            setDropAt(event.clientY < box.top + box.height / 2 ? index : index + 1);
        },
        onDrop: (event: DragEvent) => {
            event.preventDefault();
            if (dragging !== null && dropAt !== null) {
                // Landing below itself counts the gap it leaves behind.
                move(dragging, dropAt > dragging ? dropAt - 1 : dropAt);
            }
            end();
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

    return { ids, reset, added, removed, rowProps, handleProps, dragging, dropAt };
}
