"use client";

/**
 * One sound per device, however many tabs are open.
 *
 * The tabs of a browser already elect one of themselves to hold the live
 * connection - see `shared-stream` - and every effect belonging to the machine
 * rather than to a tab was hung off winning that election. That is not enough on
 * its own, and in two ordinary situations it is not true at all:
 *
 * - **A deployment served over plain http.** Web Locks are unavailable outside a
 *   secure context, and a Polaris reached at a LAN address is exactly that, so
 *   there is no election to win: every tab opens a connection of its own and
 *   every tab believes it is the one holding it. Four windows, four chimes.
 * - **A holder the browser froze.** A long-hidden background tab stops being
 *   served, so the tabs waiting on it give up after a while and connect for
 *   themselves - correctly, because the alternative is a device that goes deaf.
 *   From then on several tabs each hold a connection, and each of them is an
 *   owner.
 *
 * So the effect claims the moment instead of the connection. The claim is
 * written to `localStorage`, which every tab of the origin shares and writes
 * synchronously, and the writer then reads it back: two tabs writing at the same
 * instant both find the later of the two, so exactly one recognises its own
 * claim and the other stays quiet. A claim still inside its window is not
 * contested at all, which is also what turns a burst of arrivals into one chime
 * rather than five.
 *
 * Nothing here is allowed to make a device silent. A browser that refuses
 * storage - private browsing, a blocked origin - is treated as a device of one
 * tab and the effect runs: a doubled chime is an annoyance, a swallowed one is a
 * missed message.
 */

import { z } from "zod";

const PREFIX = "polaris.device-once:";

/** How long a claim keeps the next one quiet when the caller names no span. Long
 *  enough that the frames of one burst are one sound, short enough that two
 *  arrivals a second apart are still two. */
const HOLD_MS = 900;

/** How long the writer waits for a competing tab's write to land before deciding
 *  which of them won. Imperceptible before a chime, and generous for a write
 *  that never leaves the machine. */
const SETTLE_MS = 60;

/** This document, for as long as it lives. Two tabs opened in the same
 *  millisecond are told apart by the random half. */
const TAB = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;

/** A store that would not answer. Told apart from "nobody has claimed this",
 *  because the two lead to opposite answers: an uncontested key is this tab's to
 *  take, and a store that cannot be read can name no winner at all. */
const UNREADABLE = Symbol("unreadable");

let sequence = 0;

const claimSchema = z.object({ token: z.string(), at: z.number() });

type Claim = z.infer<typeof claimSchema>;

/**
 * Whether this tab is the one that should run `key` right now.
 *
 * Resolves false in every other tab of the device, and false again for anything
 * asking for the same key inside `holdMs`. Always resolves - a browser with no
 * usable storage answers true rather than leaving the effect undone.
 */
export async function claimForDevice(key: string, holdMs: number = HOLD_MS): Promise<boolean> {
    const store = storage();
    if (!store) return true;

    const name = `${PREFIX}${key}`;
    const now = Date.now();
    const held = read(store, name);
    if (held === UNREADABLE) return true;
    // Somebody already has this moment. A clock that moved backwards leaves a
    // claim stamped in the future, and that has to expire rather than silence
    // the device until the clock catches up with it.
    if (held && held.at <= now && now - held.at < holdMs) return false;

    sequence += 1;
    const token = `${TAB}:${sequence}`;
    if (!write(store, name, { token, at: now })) return true;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const settled = read(store, name);
    // A store that stopped answering in between cannot say which tab won, and
    // between two chimes and none, two is the one somebody hears.
    return settled === UNREADABLE || settled?.token === token;
}

function read(store: Storage, name: string): Claim | null | typeof UNREADABLE {
    let raw: string | null;
    try {
        raw = store.getItem(name);
    } catch {
        return UNREADABLE;
    }
    if (!raw) return null;
    try {
        const parsed = claimSchema.safeParse(JSON.parse(raw));
        // Written by a build that shaped it differently, or by something else
        // entirely. Uncontested is the safe reading: the effect still happens.
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function write(store: Storage, name: string, claim: Claim): boolean {
    try {
        store.setItem(name, JSON.stringify(claim));
        return true;
    } catch {
        // A full or read-only store. Nothing can be shared, so every tab is on
        // its own and answering true is the honest end of that.
        return false;
    }
}

function storage(): Storage | null {
    try {
        return typeof window === "undefined" ? null : window.localStorage;
    } catch {
        return null;
    }
}
