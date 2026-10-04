"use client";

/**
 * What the reader has just done to their mail, held until a list can be
 * trusted to say it too.
 *
 * Every change to a conversation - read, starred, archived, deleted - is drawn
 * at once and confirmed by somebody else's mail server after. The screen used to
 * drop the overlay whenever a new list arrived, on the theory that a new list is
 * the server's word. It is not: a list can have been ASKED FOR before the change
 * was confirmed - the copy this tab or this device kept, a refresh the live
 * channel started a moment earlier, the one closing the reading pane triggers -
 * and every one of those still says unread, or still holds the row. Dropping
 * the overlay on one of them is how a message opened and left at once went back
 * to bold, and how a conversation just deleted came back.
 *
 * So the rule is time, not arrival: **an answer may contradict a change only if
 * it was requested after that change was confirmed.** Anything older is shown
 * with the change laid over it. A refusal takes the change away at once, so the
 * server's row shows again. A confirmed change is let go once every list on
 * screen has been asked for since, and forgotten after a while regardless.
 *
 * Tab-wide rather than per screen, because the lists that disagree outlive it:
 * a mailbox left and come back to paints the copy kept before the change.
 */

import { withPatch, type ThreadPatch } from "./optimistic";

/** One change, from the press to the server's answer. */
export interface PendingChange {
    readonly id: number;
    readonly threadIds: readonly string[];
    readonly change: ThreadPatch;
    /** When the server confirmed it, or null while it is still being asked. */
    readonly settledAt: number | null;
}

/** How long a confirmed change is still laid over old answers. Longer than any
 *  list this tab could be holding from before it, with a margin. */
export const SETTLED_KEEP_MS = 2 * 60 * 1000;

/**
 * The overlays a list answer requested at `requestedAt` still owes, by
 * conversation. An answer with no stamp - a copy kept on the device, nothing
 * fetched yet - is 0, older than every change.
 */
export function overlaysFor(
    changes: readonly PendingChange[],
    requestedAt: number,
    now: number
): Record<string, ThreadPatch> {
    let owed: Record<string, ThreadPatch> = {};
    for (const one of changes) {
        if (one.settledAt !== null && now - one.settledAt > SETTLED_KEEP_MS) continue;
        if (one.settledAt !== null && requestedAt >= one.settledAt) continue;
        owed = withPatch(owed, one.threadIds, one.change);
    }
    return owed;
}

interface Ledger {
    changes: PendingChange[];
    next: number;
    version: number;
    readonly listeners: Set<() => void>;
}

/** On `globalThis`, so the bundles a route can be split into share one. */
const KEY = Symbol.for("polaris.mail.pending-changes");

function ledger(): Ledger {
    const slot = globalThis as unknown as Record<symbol, Ledger | undefined>;
    slot[KEY] ??= { changes: [], next: 1, version: 0, listeners: new Set() };
    return slot[KEY]!;
}

function changed(): void {
    const held = ledger();
    const now = Date.now();
    // Forgotten once nothing could still be owed them.
    held.changes = held.changes.filter(
        (one) => one.settledAt === null || now - one.settledAt <= SETTLED_KEEP_MS
    );
    held.version += 1;
    for (const listener of held.listeners) listener();
}

/** A change being asked for. Settle it when the server agrees, abandon it when
 *  the server refuses. */
export interface PendingHandle {
    readonly settle: () => void;
    readonly abandon: () => void;
}

export function beginChange(threadIds: readonly string[], change: ThreadPatch): PendingHandle {
    const held = ledger();
    const id = held.next++;
    if (threadIds.length > 0) {
        held.changes = [...held.changes, { id, threadIds: [...threadIds], change, settledAt: null }];
        changed();
    }
    // Answered once: a second answer - a settle after a settle, a refusal after
    // a yes - changes nothing.
    const open = () => held.changes.some((one) => one.id === id && one.settledAt === null);
    return {
        settle: () => {
            if (!open()) return;
            const at = Date.now();
            held.changes = held.changes.map((one) =>
                one.id === id ? { ...one, settledAt: at } : one
            );
            changed();
        },
        abandon: () => {
            if (!open()) return;
            held.changes = held.changes.filter((one) => one.id !== id);
            changed();
        }
    };
}

/** Every change still being asked for or still owed, for a screen to draw. */
export function pendingChanges(): readonly PendingChange[] {
    return ledger().changes;
}

export function subscribePendingChanges(listener: () => void): () => void {
    const held = ledger();
    held.listeners.add(listener);
    return () => held.listeners.delete(listener);
}

export function pendingChangesVersion(): number {
    return ledger().version;
}

/** Forget everything. For tests. */
export function resetPendingChanges(): void {
    const held = ledger();
    held.changes = [];
    held.version += 1;
}
