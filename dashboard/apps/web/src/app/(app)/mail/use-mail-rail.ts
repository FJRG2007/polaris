"use client";

/**
 * Which mailboxes the reader has open in the rail.
 *
 * A mailbox in the rail expands to the folders it actually has on its server,
 * and that was state a component held: it closed on every reload and on every
 * navigation that remounted the rail. Somebody who works out of one folder of
 * one mailbox had to open it again every time they came back to Mail, which is
 * the sort of thing nobody reports as a bug and everybody stops using the rail
 * over.
 *
 * Kept in the browser rather than on the account, for the same reason the layout
 * is - see `use-mail-layout`, which this deliberately mirrors. It is a
 * preference about this screen on this device: a phone and a desk are not the
 * same rail, and a folder tree opened on one is not a decision made for the
 * other.
 *
 * Read on mount rather than during render. A value that differs between the
 * server's HTML and the browser's first paint is a hydration mismatch, so the
 * rail paints closed and opens on the answer - which is one frame, and the
 * alternative is React throwing away the tree.
 *
 * Mailboxes that have since gone are dropped on the way out rather than on the
 * way in: a mailbox being reconnected keeps its place, and a list of dead ids
 * never grows without bound.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const KEY = "polaris.mail.rail.open";

/** How many are remembered. Somebody with more mailboxes than this open at once
 *  is not reading a rail, and it caps what a stale browser can carry. */
const LIMIT = 32;

function read(): string[] {
    try {
        const held: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
        if (!Array.isArray(held)) return [];
        return held.filter((one): one is string => typeof one === "string").slice(0, LIMIT);
    } catch {
        // Not an array, not JSON, or a browser told to keep no site data. A
        // closed rail is a working rail.
        return [];
    }
}

export function useMailRailOpen(mailboxes: readonly string[]): {
    readonly open: ReadonlySet<string>;
    readonly toggle: (accountId: string) => void;
} {
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    /** The mailboxes there actually are, as of the last render. Read through a
     *  ref so a list that is a new array every render does not rebuild `toggle`,
     *  and so what is written is measured against the rail being looked at. */
    const known = useRef<readonly string[]>(mailboxes);

    useEffect(() => {
        known.current = mailboxes;
    }, [mailboxes]);

    useEffect(() => {
        const held = read();
        if (held.length > 0) setOpen(new Set(held));
    }, []);

    const toggle = useCallback((accountId: string) => {
        setOpen((held) => {
            const next = new Set(held);
            if (!next.delete(accountId)) next.add(accountId);
            // Only what is still there is written back, which is where the dead
            // ids go - a slot held by a mailbox that was removed a year ago is a
            // slot the rail cannot use.
            const kept = [...next].filter((id) => known.current.includes(id)).slice(0, LIMIT);
            try {
                window.localStorage.setItem(KEY, JSON.stringify(kept));
            } catch {
                // It still opens for this visit; it just will not be remembered.
            }
            return next;
        });
    }, []);

    return { open, toggle };
}
