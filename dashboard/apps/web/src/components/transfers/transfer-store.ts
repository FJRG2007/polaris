"use client";

/**
 * What is moving, and how far it has got.
 *
 * Polaris sends and receives files from a dozen screens - a conversation, a Drive,
 * a mail, a task, a deploy's own files, a profile photo - and every one of them
 * used to say the same nothing while it happened. A small file is instant and
 * nobody noticed; a large one is a button that looks pressed and a screen that
 * looks stuck, and the thing people do then is press it again.
 *
 * So there is one place that knows about transfers, and it is deliberately not
 * per-screen: what somebody wants to know is "is my file still going", and the
 * answer has to survive them walking off the screen they started it from - which
 * is the normal thing to do during a ten-minute upload.
 *
 * A module-level store rather than context state, for two reasons that are the
 * same reason twice: the helpers that do the sending are plain functions called
 * from event handlers and effects, not hooks, and a transfer must not be tied to
 * the lifetime of the component that started it. Subscribers are told on every
 * change; `useTransfers` is the hook over it.
 */

import { useEffect, useState } from "react";

/** Which way the bytes are going, which is all a reader needs to know about it. */
export type TransferWay = "up" | "down";

export type TransferState =
    /** Asked for, nothing measurable yet. A file on a share behind a fresh
     *  connection can be many seconds before its first byte. */
    | "waiting"
    | "moving"
    | "done"
    | "failed"
    /** Stopped by whoever started it. */
    | "stopped";

export interface Transfer {
    readonly id: string;
    readonly name: string;
    readonly way: TransferWay;
    readonly state: TransferState;
    /** Bytes so far. */
    readonly moved: number;
    /** What it weighs, when that is known: an upload always knows, a download
     *  knows when the server said so. Null is a transfer with no percentage to
     *  show, which is a real state rather than a missing one. */
    readonly total: number | null;
    /** Why it failed, in the words the reader gets. */
    readonly error?: string;
    /** Where it started, for the rate and for the "how long left". */
    readonly startedAt: number;
    /** Set while it can still be called off. */
    readonly stop?: () => void;
}

/** Everything that has not been cleared, newest last. */
let transfers: Transfer[] = [];
const listeners = new Set<() => void>();

function announce(): void {
    for (const listener of listeners) listener();
}

/** How long a finished transfer stays on screen before it takes itself away. Long
 *  enough to be read as "that worked", short enough that a morning of uploads is
 *  not a wall. A failed one stays until it is dismissed. */
const CLEAR_AFTER_MS = 6000;

export function transfersNow(): readonly Transfer[] {
    return transfers;
}

/** Start one. The handle is what the caller reports progress on - see `sendFile`
 *  and `saveFile`, which are the two things that should normally be used instead
 *  of driving this by hand. */
export function beginTransfer(input: {
    readonly name: string;
    readonly way: TransferWay;
    readonly total?: number | null;
    readonly stop?: () => void;
}): TransferHandle {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    transfers = [
        ...transfers,
        {
            id,
            name: input.name,
            way: input.way,
            state: "waiting",
            moved: 0,
            total: input.total ?? null,
            startedAt: Date.now(),
            stop: input.stop
        }
    ];
    announce();
    return new TransferHandle(id);
}

/** One transfer, as its sender talks to it. */
export class TransferHandle {
    constructor(public readonly id: string) {}

    /** How far it has got. A total that arrives later - a download learning its
     *  size from the headers - is taken here too. */
    public moved(bytes: number, total?: number | null): void {
        patch(this.id, (was) => ({
            ...was,
            state: was.state === "waiting" ? "moving" : was.state,
            moved: bytes,
            total: total ?? was.total
        }));
    }

    public done(): void {
        patch(this.id, (was) => ({
            ...was,
            state: "done",
            moved: was.total ?? was.moved,
            stop: undefined
        }));
        clearLater(this.id);
    }

    /** It will not finish. The sentence is the reader's, so it must be one they
     *  can act on rather than the exception's own words. */
    public failed(error: string): void {
        patch(this.id, (was) => ({ ...was, state: "failed", error, stop: undefined }));
    }

    public stopped(): void {
        patch(this.id, (was) => ({ ...was, state: "stopped", stop: undefined }));
        clearLater(this.id);
    }
}

/** Take one off the list. What the X on a failed transfer does. */
export function clearTransfer(id: string): void {
    transfers = transfers.filter((entry) => entry.id !== id);
    announce();
}

/** Take every finished one off at once. */
export function clearSettledTransfers(): void {
    transfers = transfers.filter(
        (entry) => entry.state === "waiting" || entry.state === "moving"
    );
    announce();
}

function patch(id: string, change: (was: Transfer) => Transfer): void {
    let touched = false;
    transfers = transfers.map((entry) => {
        if (entry.id !== id) return entry;
        touched = true;
        return change(entry);
    });
    if (touched) announce();
}

function clearLater(id: string): void {
    if (typeof window === "undefined") return;
    window.setTimeout(() => clearTransfer(id), CLEAR_AFTER_MS);
}

/** The live list, for anything that draws it. */
export function useTransfers(): readonly Transfer[] {
    const [shown, setShown] = useState<readonly Transfer[]>(transfers);
    useEffect(() => {
        const listener = () => setShown(transfers);
        listeners.add(listener);
        // Anything that started before this mounted, which is the normal case for
        // a panel that appears because a transfer began.
        listener();
        return () => {
            listeners.delete(listener);
        };
    }, []);
    return shown;
}

/**
 * How far along one transfer is, as a fraction, or null where there is nothing
 * honest to draw.
 *
 * A bar that fills at a rate nobody chose is worse than no bar: it says "this is
 * how much is left" and it is guessing. A transfer with no total gets a moving
 * stripe and the bytes so far instead.
 */
export function transferFraction(transfer: Transfer): number | null {
    if (transfer.state === "done") return 1;
    if (!transfer.total || transfer.total <= 0) return null;
    return Math.min(1, transfer.moved / transfer.total);
}

/**
 * What is left, in seconds, from the rate so far.
 *
 * Null until there is enough to divide by - the first moments of a transfer are
 * all connection and no bytes, and "3 hours remaining" for a file that takes four
 * seconds is the estimate everybody has learnt to ignore.
 */
export function transferSecondsLeft(transfer: Transfer, now = Date.now()): number | null {
    if (!transfer.total || transfer.moved <= 0) return null;
    const seconds = (now - transfer.startedAt) / 1000;
    if (seconds < 1.5) return null;
    const rate = transfer.moved / seconds;
    if (rate <= 0) return null;
    return Math.max(0, Math.round((transfer.total - transfer.moved) / rate));
}
