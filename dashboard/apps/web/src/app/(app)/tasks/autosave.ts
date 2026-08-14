"use client";

/**
 * Holding an edit until typing stops, and never dropping one.
 *
 * A field that saves when it loses focus has a moment where what was written
 * exists nowhere but the screen: between the last keystroke and the blur. Close
 * the panel in that moment - which is exactly what somebody does after writing a
 * description - and the text is gone. That is the one failure a work manager may
 * not have, because the person typing believed it was kept.
 *
 * So a keystroke is held rather than sent: it replaces whatever was held for the
 * same field and restarts a short timer, and the timer writes it. The rest of this
 * module is the two ways that can still lose something.
 *
 * Writes go out one at a time, in the order they were made, so a save that started
 * late cannot land on top of a later one - a task whose description reverts to the
 * previous sentence a second after it was saved is a race, not a save.
 *
 * And closing waits. `flush` sends what is held, waits for what is already going,
 * and reports whether all of it was taken. A panel that closes over a refused write
 * has lost the edit as thoroughly as one that never sent it, so the caller is told
 * and can stay open with the text still in it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** A write with its value already in it. False when the server would not take it. */
export type Write = () => Promise<boolean>;

/** Long enough that a typed sentence is one write, short enough to feel kept. */
const SETTLE_MS = 600;

export interface Autosave {
    /** Hold this field's write until typing stops, replacing what was held for it. */
    queue: (field: string, write: Write) => void;
    /** Write now, dropping what was held for the same field - the caller has a newer
     *  value for it. Anything held for another field goes out first, in order. */
    save: (field: string, write: Write) => Promise<boolean>;
    /** Send everything held and wait for every write still on its way. False when one
     *  of them was refused, which leaves it held for the next attempt. */
    flush: () => Promise<boolean>;
    /** Let go of what is held without writing it. The only way out of an edit the
     *  server will not take, so the caller must have asked before calling it. */
    discard: () => void;
    /** An edit is on its way, or waiting to go. */
    busy: boolean;
}

export function useAutosave(settleMs: number = SETTLE_MS): Autosave {
    const held = useRef(new Map<string, Write>());
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // One chain rather than a set of promises. Two writes to the same task in
    // flight together is how the older one wins, and the order they were typed in
    // is the only order that can be right.
    const chain = useRef<Promise<unknown>>(Promise.resolve());
    const going = useRef(0);
    const refused = useRef(0);
    const [busy, setBusy] = useState(false);

    const sync = useCallback(() => setBusy(going.current > 0 || held.current.size > 0), []);

    const stopTimer = useCallback(() => {
        if (!timer.current) return;
        clearTimeout(timer.current);
        timer.current = null;
    }, []);

    const send = useCallback(
        (field: string, write: Write): Promise<boolean> => {
            going.current += 1;
            sync();
            const settle = (taken: boolean) => {
                if (!taken) {
                    refused.current += 1;
                    // A refused write is still an unsaved edit, so it goes back to
                    // being held: the next attempt sends it again rather than the
                    // panel forgetting the text was ever typed. Anything newer for
                    // the same field supersedes it.
                    if (!held.current.has(field)) held.current.set(field, write);
                }
                going.current -= 1;
                sync();
                return taken;
            };
            // The predecessor's outcome is not this write's business, so a refused
            // one is awaited the same as a taken one rather than taking the chain
            // down with it.
            const done = chain.current.then(write, write).then(settle, () => settle(false));
            chain.current = done;
            return done;
        },
        [sync]
    );

    /** One pass: everything held goes out, in the order it was held. */
    const dispatch = useCallback(() => {
        if (held.current.size === 0) return;
        const writes = [...held.current.entries()];
        held.current.clear();
        sync();
        for (const [field, write] of writes) void send(field, write);
    }, [send, sync]);

    const flush = useCallback(async (): Promise<boolean> => {
        const before = refused.current;
        // Anything typed while these are going out goes with them, so what is
        // waited for is the last keystroke rather than the first.
        while (held.current.size > 0 || going.current > 0) {
            stopTimer();
            dispatch();
            await chain.current;
            // A refused write has put itself back. Sending it again from here would
            // be a loop; what to do about it is the caller's decision.
            if (refused.current !== before) return false;
        }
        return true;
    }, [dispatch, stopTimer]);

    const queue = useCallback(
        (field: string, write: Write) => {
            held.current.set(field, write);
            sync();
            stopTimer();
            // One pass and no waiting on it: the next keystroke arms the timer again.
            // Looping the way the close does - which has to, because it is waiting for
            // the last keystroke there will be - would take the timer down again the
            // moment the write in flight answered, and somebody who keeps typing would
            // get a write, and a line of history, per round trip instead of per pause.
            timer.current = setTimeout(() => {
                timer.current = null;
                dispatch();
            }, settleMs);
        },
        [dispatch, settleMs, stopTimer, sync]
    );

    const save = useCallback(
        (field: string, write: Write): Promise<boolean> => {
            stopTimer();
            held.current.delete(field);
            const others = [...held.current.entries()];
            held.current.clear();
            sync();
            for (const [other, otherWrite] of others) void send(other, otherWrite);
            return send(field, write);
        },
        [send, stopTimer, sync]
    );

    // An edit the server keeps refusing would otherwise be held for as long as the
    // page lives: every attempt to leave sends it, is refused, and reports false, so
    // there is no way out of the panel and the page keeps warning on the way out.
    // Letting go of it is the caller's to ask about and the caller's to offer.
    const discard = useCallback(() => {
        stopTimer();
        held.current.clear();
        sync();
    }, [stopTimer, sync]);

    // Leaving the page with an edit still held is the one case nothing here can
    // save its way out of, so it is the one case worth interrupting.
    useEffect(() => {
        if (!busy) return;
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [busy]);

    // Torn off the page - a navigation, the view behind re-rendering - there is
    // nothing left to await with, but the write still goes out.
    useEffect(
        () => () => {
            stopTimer();
            const writes = [...held.current.entries()];
            held.current.clear();
            for (const [field, write] of writes) void send(field, write);
        },
        [send, stopTimer]
    );

    return { queue, save, flush, discard, busy };
}
