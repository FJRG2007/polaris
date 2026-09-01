/**
 * Whether a username can be taken, and what to take instead when it cannot.
 *
 * A username field with no answer until Save is a field somebody fills in, waits
 * on, and is then told to try again with no idea what would work. Every product
 * with handles answers while the person is typing, and offers a way out of the
 * dead end rather than just naming it.
 *
 * **The suggestions are built from what the account already holds** - the name
 * they type into the same form, the two halves of their legal name, the local
 * part of the address they sign in with - because a suggestion made of somebody
 * else's vocabulary is a suggestion nobody takes. What they typed comes first,
 * with the smallest change that frees it, and the rest read as names rather than
 * as slots: `ada.lovelace` before `ada1847`.
 *
 * **This surface does say whether a handle exists.** That is unavoidable: a
 * field that would not tell you a name is taken is a field that lets two people
 * take it. It is deliberately narrow - it answers about ONE handle at a time, it
 * says nothing else about the account behind it, it needs a session, and it is
 * rate-limited per account, so it is a question about the namespace rather than a
 * way to walk the roster. Somebody's `discoverable` setting governs whether they
 * can be found, which is a different question and is answered elsewhere.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { isReservedUsername } from "@polaris/core";

/** How many suggestions are worth offering. Past a handful it is a list to read
 *  rather than a way out, and the ones at the bottom are always the worst. */
export const MOST_SUGGESTIONS = 5;

/** What one check answers. */
export interface UsernameVerdict {
    /** The handle as it would be stored: trimmed and lowercased. */
    readonly handle: string;
    /** Whether it can be taken by this account right now. */
    readonly free: boolean;
    /** Why not, in a sentence for the person. Empty when it is free. */
    readonly problem: string;
    /** Names that are free, when the one asked about is not. Empty otherwise:
     *  offering alternatives to somebody whose choice worked is noise. */
    readonly suggestions: readonly string[];
}

/** Everything a suggestion may be built out of. All optional - an account that
 *  has filled in nothing still gets answers, they are just less personal. */
export interface UsernameSeeds {
    readonly display?: string;
    readonly firstName?: string;
    readonly lastName?: string;
    readonly email?: string;
}

/** The handle as Polaris stores one. */
function normalize(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Which of these handles are already somebody's.
 *
 * One query for the whole set rather than one per candidate: a check plus five
 * suggestions is six questions about the same column, and asking them separately
 * is six round trips to answer one keystroke.
 *
 * The account doing the asking is excluded, so somebody re-typing the handle
 * they already have is told it is theirs rather than that it is taken.
 */
async function takenAmong(handles: readonly string[], exceptUserId: string): Promise<Set<string>> {
    if (handles.length === 0) return new Set();
    const rows = await prisma.user.findMany({
        where: { username: { in: [...handles] }, id: { not: exceptUserId } },
        select: { username: true }
    });
    return new Set(rows.map((row) => row.username ?? ""));
}

/**
 * The words an account can be named after, in the order they are worth trying.
 *
 * Each is reduced to what a handle may contain rather than rejected for
 * containing anything else: "Ada Lovelace" is a perfectly good source for
 * `adalovelace`, and dropping it because of the space would leave most accounts
 * with nothing to suggest.
 */
function seedWords(seeds: UsernameSeeds): string[] {
    const clean = (value: string | undefined) =>
        (value ?? "")
            .normalize("NFD")
            // The accents come off rather than the letters under them: José is a
            // good source for `jose`, and refusing the name is not an option.
            // Written as escapes because a line of bare combining marks is a
            // line nobody can read or safely edit.
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "");

    const first = clean(seeds.firstName);
    const last = clean(seeds.lastName);
    // Only the local part. Nobody wants a handle with their mail provider in it.
    const local = clean((seeds.email ?? "").split("@")[0]);
    const display = clean(seeds.display);

    return [first && last ? `${first}.${last}` : "", first && last ? `${first}${last}` : "", display, local, first]
        .filter((word) => word.length > 0);
}

/** Long enough to be a handle, short enough for the column. */
function usable(handle: string): boolean {
    return handle.length >= 3 && handle.length <= 30 && !isReservedUsername(handle);
}

/**
 * Names to offer instead, in the order they are worth offering.
 *
 * The order is the whole design, and the first version got it wrong: it put
 * every near-variant of the wanted handle first, so a person whose choice was
 * taken was offered `ada.1`, `ada_`, `ada-1`, `ada.dev` and `ada.me` - five ways
 * of saying the same thing, none of which is a name.
 *
 * So it is one close variant, then the names built out of who this account
 * actually is, then the rest. Somebody who typed `ada` does want something like
 * `ada`, but they want `ada.lovelace` more than they want four more punctuation
 * marks, and a bare counter is the last resort every product falls back to and
 * reads like one.
 *
 * Candidates are generated well past what is offered, because most of them will
 * be taken on an instance where the good ones already are.
 */
function candidatesFor(wanted: string, seeds: UsernameSeeds): string[] {
    const words = seedWords(seeds);
    const out: string[] = [];

    // One. Enough to say "something like what you typed is available", not
    // enough to crowd out the names below.
    if (wanted) out.push(`${wanted}.1`);
    out.push(...words);
    for (const word of words) {
        for (const suffix of [".1", "1", "_"]) out.push(`${word}${suffix}`);
    }
    if (wanted) {
        for (const suffix of ["_", "-1", ".dev", ".me"]) out.push(`${wanted}${suffix}`);
        for (let number = 2; number <= 12; number += 1) out.push(`${wanted}${number}`);
    }

    // Deduplicated in order, so the best version of a repeated idea survives.
    const seen = new Set<string>();
    return out.filter((handle) => {
        if (!usable(handle) || seen.has(handle)) return false;
        seen.add(handle);
        return true;
    });
}

/**
 * Whether one handle is free for this account, and what else to try.
 *
 * The shape of a handle is not judged here: that is `usernameField`, which the
 * form and the server both already run, and a second opinion on it in this file
 * would be a second set of rules to keep in step. What this answers is the one
 * question a schema cannot: whether somebody else has it.
 */
export async function checkUsername(
    userId: string,
    wanted: string,
    seeds: UsernameSeeds
): Promise<UsernameVerdict> {
    const handle = normalize(wanted);
    const candidates = candidatesFor(handle, seeds);
    const taken = await takenAmong([handle, ...candidates], userId);

    const free = handle.length > 0 && !taken.has(handle);
    return {
        handle,
        free,
        problem: free ? "" : "That username is taken",
        suggestions: free
            ? []
            : candidates.filter((candidate) => !taken.has(candidate)).slice(0, MOST_SUGGESTIONS)
    };
}
