/**
 * What a pairing has to carry from one step to the next that must never leave
 * the server: an account id that signs in on its own, a token pair, a value
 * read out of an uploaded app.
 *
 * A pairing's state travels to the browser and back (`contract.ts`), and that
 * state is shown to whoever is pairing. So such a value stays here, in memory,
 * and the browser only ever holds a handle to it: 32 random bytes, which say
 * nothing and are good for one purpose and for a short while. Nothing is
 * written anywhere - a restart in the middle of a pairing loses it, and the
 * dialog says to start again, which is the price of the value never being
 * anywhere but in this process.
 *
 * Bounded: an entry lives at most its own lifetime, and the vault holds at
 * most `CAPACITY` of them, the oldest dropped first.
 *
 * Kept on `globalThis` under a registered symbol, because the route that reads
 * an upload and the action that polls can be separate copies of this module in
 * one process; the vault has to be the same one for both.
 *
 * Server-only.
 */

import { HomeError } from "./home-error";
import { randomBytes } from "node:crypto";

const CAPACITY = 200;

interface Held {
    readonly purpose: string;
    readonly expiresAt: number;
    readonly data: Readonly<Record<string, string>>;
}

const KEY = Symbol.for("polaris.places.pairing-vault");

function vault(): Map<string, Held> {
    const scope = globalThis as unknown as Record<symbol, Map<string, Held> | undefined>;
    let held = scope[KEY];
    if (!held) {
        held = new Map();
        scope[KEY] = held;
    }
    return held;
}

function sweep(held: Map<string, Held>, now: number): void {
    for (const [handle, entry] of held) if (entry.expiresAt < now) held.delete(handle);
    // Insertion order is age order: the first ones are the oldest.
    while (held.size >= CAPACITY) held.delete(held.keys().next().value!);
}

/** Keep some values for one purpose, for `ttlMs`, and answer the handle the
 *  browser may carry instead of them. */
export function holdPairing(
    purpose: string,
    data: Readonly<Record<string, string>>,
    ttlMs: number,
    now: number = Date.now()
): string {
    const held = vault();
    sweep(held, now);
    const handle = randomBytes(32).toString("base64url");
    held.set(handle, { purpose, expiresAt: now + ttlMs, data: { ...data } });
    return handle;
}

/** The values a handle stands for, or a refusal for one that ran out, was made
 *  for something else, or was never handed out. */
export function readPairing(
    purpose: string,
    handle: string | undefined,
    now: number = Date.now()
): Readonly<Record<string, string>> {
    const entry = handle ? vault().get(handle) : undefined;
    if (!entry || entry.purpose !== purpose || entry.expiresAt < now) {
        throw new HomeError("That step took too long and has run out. Start connecting again.");
    }
    return entry.data;
}

/** Let go of a handle once its pairing is finished. */
export function dropPairing(handle: string | undefined): void {
    if (handle) vault().delete(handle);
}
