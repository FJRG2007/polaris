"use client";

import { useEffect, useRef, useState } from "react";

/** How long keyboard presses are gathered before they are sent as one change. */
export const KEY_SETTLE_MS = 700;

/**
 * The value a dragged control shows, and when it is sent.
 *
 * A drag shows every value at once and sends one: the one it was let go on -
 * Home Assistant's controls behave the same, and a device asked for forty
 * brightness levels in a second answers the first and drops the rest. Key
 * presses have no "let go", so they are gathered for a moment and sent as one.
 * Ending where the device already is sends nothing at all.
 *
 * What was sent is held on screen until the device's value moves - the screen
 * above applies a change before the answer arrives and puts it back on a
 * refusal - so the control never jumps back to the old value in between.
 */
export function useReleasedValue<T>(
    value: T,
    onCommit: (next: T) => void,
    {
        settleMs = KEY_SETTLE_MS,
        onLive
    }: {
        settleMs?: number;
        /** Told the value being shown while one is held, and null once it is
         *  the device's own again: for a number drawn outside the control. */
        onLive?: (shown: T | null) => void;
    } = {}
) {
    const [draft, setDraft] = useState<{ readonly value: T } | null>(null);
    const holding = useRef(false);
    const live = useRef<{ readonly value: T } | null>(null);
    const pending = useRef<{ readonly value: T } | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const current = useRef(value);
    current.current = value;
    const commit = useRef(onCommit);
    commit.current = onCommit;
    const tell = useRef(onLive);
    tell.current = onLive;

    const same = (a: T, b: T) => String(a) === String(b);

    const send = (next: T) => {
        if (same(next, current.current)) setDraft(null);
        else commit.current(next);
    };

    const flush = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        const next = pending.current;
        pending.current = null;
        if (next) send(next.value);
    };

    // The device's value moved - the change landed, or was put back: show it.
    const key = String(value);
    useEffect(() => {
        if (!holding.current && !timer.current) setDraft(null);
    }, [key]);

    const draftKey = draft === null ? null : String(draft.value);
    useEffect(() => {
        tell.current?.(draft === null ? null : draft.value);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by what is shown.
    }, [draftKey]);

    // Leaving with presses gathered sends them rather than dropping them.
    useEffect(
        () => () => {
            const dragged = live.current;
            if (dragged && holding.current) pending.current = dragged;
            flush();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- on the way out only.
        []
    );

    return {
        shown: draft === null ? value : draft.value,
        holding: () => holding.current,
        /** A point of a drag: shown, not sent. */
        drag(next: T) {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            pending.current = null;
            holding.current = true;
            live.current = { value: next };
            setDraft({ value: next });
        },
        /** The drag let go of: the last value it showed is sent. */
        release() {
            const dragged = live.current;
            holding.current = false;
            live.current = null;
            if (dragged) send(dragged.value);
        },
        /** The drag taken away (the page scrolled instead): nothing is sent. */
        cancel() {
            holding.current = false;
            live.current = null;
            setDraft(null);
        },
        /** A key press: shown at once, sent once the keys have been still. */
        nudge(next: T) {
            pending.current = { value: next };
            setDraft({ value: next });
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(flush, settleMs);
        },
        /** Send what the keys gathered now, as on leaving the control. */
        flush
    };
}
