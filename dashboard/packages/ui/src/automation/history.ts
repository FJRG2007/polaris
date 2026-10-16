"use client";

/**
 * Undo and redo for a draft being edited: every change is a step that can be
 * taken back, up to `HISTORY_LIMIT` of them, and taking one back then making a
 * new change forgets what could have been redone.
 *
 * Typing is not one step per key: changes that arrive close together and say
 * they may be grouped (`group`, the default) fold into the step before them, so
 * one undo takes back the word that was typed. Anything structural - a block
 * added, moved, pasted or removed - passes `group: false` and is a step of its
 * own.
 *
 * The draft is whatever the editor keeps; this never looks inside it.
 */

import { useCallback, useRef, useState } from "react";

/** How many steps can be taken back. */
export const HISTORY_LIMIT = 75;

/** How close together two groupable changes have to be to count as one step. */
export const GROUP_MS = 800;

export interface History<T> {
    readonly past: readonly T[];
    readonly present: T;
    readonly future: readonly T[];
}

export function historyOf<T>(present: T): History<T> {
    return { past: [], present, future: [] };
}

/** `history` with `next` as the present, and the old present one step back. */
export function recorded<T>(history: History<T>, next: T, limit = HISTORY_LIMIT): History<T> {
    if (Object.is(next, history.present)) return history;
    const past = [...history.past, history.present];
    return { past: past.slice(Math.max(0, past.length - limit)), present: next, future: [] };
}

/** `history` with the present replaced and nothing recorded: the step it is part
 *  of simply ends somewhere else. */
export function amended<T>(history: History<T>, next: T): History<T> {
    return { ...history, present: next, future: [] };
}

export function undone<T>(history: History<T>): History<T> {
    const previous = history.past[history.past.length - 1];
    if (history.past.length === 0) return history;
    return {
        past: history.past.slice(0, -1),
        present: previous as T,
        future: [history.present, ...history.future]
    };
}

export function redone<T>(history: History<T>): History<T> {
    if (history.future.length === 0) return history;
    const [next, ...rest] = history.future;
    return { past: [...history.past, history.present], present: next as T, future: rest };
}

export interface DraftHistory<T> {
    readonly value: T | null;
    /** Make a change. `group` (default true) lets it fold into the step before
     *  when it follows that one closely. */
    readonly change: (change: (current: T) => T, options?: { group?: boolean }) => void;
    /** Start over from `value`, with nothing to undo: a draft just loaded. */
    readonly reset: (value: T) => void;
    /** Put `value` in place of the present without making it a step: the same
     *  draft as the server stored it after a save. */
    readonly replace: (value: T) => void;
    readonly undo: () => void;
    readonly redo: () => void;
    readonly canUndo: boolean;
    readonly canRedo: boolean;
}

export function useDraftHistory<T>(
    initial: T | null = null,
    limit = HISTORY_LIMIT
): DraftHistory<T> {
    const [history, setHistory] = useState<History<T> | null>(
        initial === null ? null : historyOf(initial)
    );
    const lastGroupable = useRef(0);

    const change = useCallback(
        (update: (current: T) => T, options?: { group?: boolean }) => {
            const group = options?.group ?? true;
            const now = Date.now();
            const folds = group && now - lastGroupable.current < GROUP_MS;
            lastGroupable.current = group ? now : 0;
            setHistory((current) => {
                if (!current) return current;
                const next = update(current.present);
                if (Object.is(next, current.present)) return current;
                return folds && current.past.length > 0
                    ? amended(current, next)
                    : recorded(current, next, limit);
            });
        },
        [limit]
    );
    const reset = useCallback((value: T) => {
        lastGroupable.current = 0;
        setHistory(historyOf(value));
    }, []);
    const replace = useCallback((value: T) => {
        setHistory((current) => (current ? { ...current, present: value } : historyOf(value)));
    }, []);
    const undo = useCallback(() => {
        lastGroupable.current = 0;
        setHistory((current) => (current ? undone(current) : current));
    }, []);
    const redo = useCallback(() => {
        lastGroupable.current = 0;
        setHistory((current) => (current ? redone(current) : current));
    }, []);

    return {
        value: history?.present ?? null,
        change,
        reset,
        replace,
        undo,
        redo,
        canUndo: (history?.past.length ?? 0) > 0,
        canRedo: (history?.future.length ?? 0) > 0
    };
}
