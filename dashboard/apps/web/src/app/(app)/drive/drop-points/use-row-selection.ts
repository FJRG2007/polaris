"use client";

/**
 * Choosing rows of a drop point table the way Drive's file list does.
 *
 * The checkbox toggles one row, Shift with a press takes the whole stretch from
 * the last one pressed, Ctrl (Cmd) with a press on the row toggles it without
 * opening it, Ctrl+A (Cmd+A) takes every row shown and Escape lets go. Built on
 * the range selection the design system already carries, so the rules are the
 * one implementation rather than a copy of it.
 *
 * Only rows still shown count: a search that hides a chosen row takes it out
 * of what a bulk action would touch, because nobody deletes what they cannot
 * see.
 */

import { allChosen, useRangeSelection } from "@polaris/ui";
import { useCallback, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";

export function useRowSelection(ids: readonly string[]) {
    const [picked, setPicked] = useState<string[]>([]);
    const chosen = useMemo(() => picked.filter((id) => ids.includes(id)), [picked, ids]);
    const range = useRangeSelection(ids, chosen, setPicked);

    const all = ids.length > 0 && chosen.length === ids.length;
    const some = chosen.length > 0 && !all;

    const toggleAll = useCallback(
        () => setPicked(all ? [] : allChosen(ids, chosen)),
        [all, ids, chosen]
    );

    const clear = useCallback(() => setPicked([]), []);

    /** A press on the checkbox: Shift takes the stretch, anything else toggles. */
    const pressBox = useCallback(
        (id: string, event: MouseEvent) => range.press(id, { shiftKey: event.shiftKey }),
        [range]
    );

    /**
     * A press anywhere on the row. With Shift or Ctrl (Cmd) it chooses rather
     * than opens, and says so, so the row's own link can stand down.
     */
    const pressRow = useCallback(
        (id: string, event: MouseEvent): boolean => {
            if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return false;
            event.preventDefault();
            range.press(id, { shiftKey: event.shiftKey });
            return true;
        },
        [range]
    );

    const onKeyDown = useCallback(
        (event: KeyboardEvent) => {
            if (event.key === "Escape" && chosen.length > 0) {
                event.preventDefault();
                setPicked([]);
                return;
            }
            range.onKeyDown(event);
        },
        [chosen.length, range]
    );

    return {
        chosen,
        isChosen: (id: string) => chosen.includes(id),
        all,
        some,
        toggleAll,
        clear,
        pressBox,
        pressRow,
        onKeyDown,
        /** Drop rows that are gone - deleted, say - from what is chosen. */
        forget: (gone: readonly string[]) =>
            setPicked((current) => current.filter((id) => !gone.includes(id)))
    };
}
