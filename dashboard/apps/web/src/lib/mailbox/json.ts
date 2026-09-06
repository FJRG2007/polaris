/**
 * The two conversions between a mail row and the JSON columns it holds.
 *
 * Addresses are stored as JSON rather than normalized into a people table
 * because they are written once, read whole, and never queried by anything but a
 * substring search - but that means every read comes back as Prisma's JSON type
 * and every write has to be handed to it as one. Doing that with a cast at each
 * of the twenty call sites is twenty places to cast to the wrong thing, so both
 * directions live here and are the only casts in the app.
 *
 * `addressesFrom` is defensive on purpose. What is in the column is what an
 * earlier version of this code put there, and a row written before a field
 * existed is the ordinary case rather than the exceptional one.
 */

import type { Prisma } from "@polaris/db";
import type * as core from "@polaris/core";

/** Addresses off a JSON column, with anything that is not one dropped. */
export function addressesFrom(value: unknown): core.MailAddress[] {
    if (!Array.isArray(value)) return [];
    const out: core.MailAddress[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const held = entry as { name?: unknown; address?: unknown };
        if (typeof held.address !== "string" || !held.address) continue;
        out.push({ name: typeof held.name === "string" ? held.name : "", address: held.address });
    }
    return out;
}

/** Strings off a JSON column - a references list, a set of message ids. */
export function stringsFrom(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Anything on its way into a JSON column. */
export function asJson(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}
