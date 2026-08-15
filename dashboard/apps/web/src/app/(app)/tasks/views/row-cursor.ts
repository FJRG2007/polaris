"use client";

/**
 * Moving through a list of tasks without the mouse.
 *
 * A list of work is the one screen people live in all day, and a screen you live
 * in has to be reachable from the keyboard - not as an accessibility box to tick
 * but because reaching for the mouse to open the next of forty rows is the thing
 * that makes a tool feel slow.
 *
 * The shape is the one every tool with this has settled on, so nobody has to
 * learn a new one: j and k, or the arrows, move a cursor; Enter opens what it is
 * on; x adds that row to the selection; Escape puts the cursor away. The cursor
 * is deliberately a separate idea from the selection - moving through a list is
 * not choosing things out of it, and a tool that conflates the two makes it
 * impossible to look at a row without acting on it.
 *
 * Shared by the two row-shaped views rather than written in each. They are the
 * same gesture over the same ids, and two copies would be two answers the first
 * time one of them gained a key.
 */

import type { SelectMode } from "./shared";
import { keyboardIsBusy } from "@/lib/keyboard";
import { useCallback, useEffect, useRef, useState } from "react";

export interface RowCursor {
    /** The task the cursor is on, or null when it is nowhere. */
    readonly at: string | null;
    /** Attach to each row, so a moved cursor can scroll itself into view. */
    readonly register: (taskId: string, element: HTMLElement | null) => void;
    /** Put the cursor somewhere directly - what a mouse press does, so the
     *  keyboard picks up from wherever the reader last looked. */
    readonly moveTo: (taskId: string | null) => void;
}

/**
 * Where the cursor lands from where it is.
 *
 * Pure, and separate from the hook, because this is the part with the off-by-one
 * in it: from nowhere, down goes to the first row and up to the last, which is
 * what makes one key enough to start from either end; and at either end it
 * stays put rather than wrapping, because a list that jumps from the bottom back
 * to the top is a list somebody loses their place in.
 */
export function nextCursor(
    ordered: readonly string[],
    current: string | null,
    delta: number
): string | null {
    if (ordered.length === 0) return null;
    const index = current === null ? -1 : ordered.indexOf(current);
    if (index === -1) return (delta > 0 ? ordered[0] : ordered[ordered.length - 1]) ?? null;
    return ordered[Math.min(ordered.length - 1, Math.max(0, index + delta))] ?? null;
}

export function useRowCursor(
    /** Every row on screen, in the order it is drawn. */
    ordered: readonly string[],
    handlers: {
        onOpen: (taskId: string) => void;
        onSelect: (taskId: string, mode: SelectMode, ordered: readonly string[]) => void;
    }
): RowCursor {
    const [at, setAt] = useState<string | null>(null);
    const elements = useRef(new Map<string, HTMLElement>());
    // Held in a ref so the listener is bound once. Rebinding on every render of
    // a list that re-renders per keystroke would be a listener churned per row.
    const latest = useRef({ ordered, handlers, at });
    latest.current = { ordered, handlers, at };

    const register = useCallback((taskId: string, element: HTMLElement | null) => {
        if (element) elements.current.set(taskId, element);
        else elements.current.delete(taskId);
    }, []);

    // A cursor on a row that has been filtered away, completed out of the view,
    // or deleted by somebody else would be a cursor nothing answers to.
    useEffect(() => {
        if (at !== null && !ordered.includes(at)) setAt(null);
    }, [ordered, at]);

    useEffect(() => {
        function move(delta: number): void {
            const { ordered: rows, at: current } = latest.current;
            const taskId = nextCursor(rows, current, delta);
            if (!taskId) return;
            setAt(taskId);
            elements.current.get(taskId)?.scrollIntoView({ block: "nearest" });
        }

        function onKeyDown(event: KeyboardEvent): void {
            if (keyboardIsBusy(event)) return;
            // A modifier means the press belongs to the browser or to a
            // selection gesture, not to this.
            if (event.metaKey || event.ctrlKey || event.altKey) return;

            const { at: current, ordered: rows, handlers: on } = latest.current;
            const key = event.key;

            if (key === "ArrowDown" || key === "j") {
                event.preventDefault();
                move(1);
                return;
            }
            if (key === "ArrowUp" || key === "k") {
                event.preventDefault();
                move(-1);
                return;
            }
            if (current === null) return;

            if (key === "Enter") {
                event.preventDefault();
                on.onOpen(current);
                return;
            }
            if (key === "x" || key === "X") {
                event.preventDefault();
                on.onSelect(current, "toggle", rows);
                return;
            }
            if (key === "Escape") {
                // Not preventDefault: Escape also closes whatever else is open,
                // and swallowing it here would strand a panel behind the list.
                setAt(null);
            }
        }

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    return { at, register, moveTo: setAt };
}
