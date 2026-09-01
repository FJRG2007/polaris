/**
 * Following a person, which is not the same as being friends with one.
 *
 * Being friends is mutual and is asked for: one side sends a request, the other
 * answers, and what it changes is what each of them may see of the other. It is
 * a relationship between two people, and both of them agreed to it.
 *
 * Following is neither. It is one-sided, it is not a request, nobody is asked,
 * and it grants nothing at all - it is somebody saying they want to see what
 * another person puts out. Which is exactly why the two exist side by side: a
 * product with only friendship makes "I want to keep an eye on what they build"
 * into a request somebody has to accept, and a product with only following has
 * no way to say "this person may see what I show my friends".
 *
 * The table is the one every other subject already uses. Following a person is
 * the same relationship as following a service - a row saying who wants to hear
 * about what - and a second table for it would be a second set of the same four
 * queries with the same three bugs.
 *
 * Nothing here decides who may READ the lists. That is one privacy setting,
 * whose default is the operator's, and it is asked in `profile-service` where
 * the lists are drawn.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { blockedBetween } from "@/lib/blocks";
import { follow, unfollow, isFollowing } from "@/lib/follow/follow";

/** The subject a person is, in the shared follow table. */
const PERSON = "user" as const;

/** Somebody, as a follower list draws them. */
export interface FollowPerson {
    readonly id: string;
    readonly name: string;
    readonly username: string;
}

export class FollowError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FollowError";
    }
}

/**
 * Start following somebody.
 *
 * Refused in one case and one only: a block, in either direction. Nothing is
 * sent, nobody is asked and nothing is granted, so there is nothing else here to
 * refuse - a private account is private to whoever reads it, which is a question
 * about the lists rather than about who may point at somebody.
 *
 * Idempotent, because the button is a toggle and a double press must not fail.
 */
export async function followPerson(viewerId: string, personId: string): Promise<void> {
    if (viewerId === personId) throw new FollowError("You cannot follow yourself");
    const person = await prisma.user.findUnique({
        where: { id: personId },
        select: { id: true, bannedAt: true }
    });
    // Said as "no such person" rather than as their state, which is nobody
    // else's business.
    if (!person || person.bannedAt) throw new FollowError("There is nobody to follow here");
    if ((await blockedBetween(viewerId, [personId])).has(personId)) {
        throw new FollowError("There is nobody to follow here");
    }
    await follow(PERSON, personId, viewerId);
}

/** Stop. Silent when they were not following, which is what a toggle needs. */
export async function unfollowPerson(viewerId: string, personId: string): Promise<void> {
    await unfollow(PERSON, personId, viewerId);
}

export async function followsPerson(viewerId: string, personId: string): Promise<boolean> {
    return isFollowing(PERSON, personId, viewerId);
}

/** How many follow them, and how many they follow. Counted rather than listed,
 *  because the numbers are drawn on every profile and the lists are not. */
export async function followCounts(personId: string): Promise<{ followers: number; following: number }> {
    const [followers, following] = await Promise.all([
        prisma.follow.count({ where: { subjectType: PERSON, subjectId: personId } }),
        prisma.follow.count({ where: { subjectType: PERSON, userId: personId } })
    ]);
    return { followers, following };
}

/** How many one page of a follower list holds. */
export const FOLLOW_PAGE_SIZE = 50;

/**
 * The people following somebody, or the people they follow.
 *
 * Ordered newest first and cut by the database: a list that can be thousands is
 * not something to send whole, and the cursor is the row's own moment rather
 * than an offset - somebody followed while the list is open shifts every offset
 * behind them.
 *
 * An account with no username is left out. The list is a list of links to
 * profiles, and there is nowhere to send anybody for an account that has not
 * taken a handle.
 */
export async function listFollow(
    personId: string,
    which: "followers" | "following",
    options: { before?: string | null; limit?: number } = {}
): Promise<{ items: FollowPerson[]; cursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? FOLLOW_PAGE_SIZE, 1), 200);
    const where =
        which === "followers"
            ? { subjectType: PERSON, subjectId: personId }
            : { subjectType: PERSON, userId: personId };

    const rows = await prisma.follow.findMany({
        where: {
            ...where,
            ...(options.before ? { createdAt: { lt: new Date(options.before) } } : {})
        },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        select: {
            createdAt: true,
            subjectId: true,
            user: { select: { id: true, name: true, username: true } }
        }
    });

    const page = rows.slice(0, limit);
    // A follower is the row's `user`; somebody they follow is the row's subject,
    // which is an id and has to be looked up.
    let people: FollowPerson[];
    if (which === "followers") {
        people = page
            .filter((row) => row.user.username)
            .map((row) => ({ id: row.user.id, name: row.user.name, username: row.user.username ?? "" }));
    } else {
        const found = await prisma.user.findMany({
            where: { id: { in: page.map((row) => row.subjectId) }, username: { not: null }, bannedAt: null },
            select: { id: true, name: true, username: true }
        });
        const byId = new Map(found.map((person) => [person.id, person]));
        people = page
            .map((row) => byId.get(row.subjectId))
            .filter((person): person is { id: string; name: string; username: string | null } => Boolean(person))
            .map((person) => ({ id: person.id, name: person.name, username: person.username ?? "" }));
    }

    return {
        items: people,
        cursor: rows.length > limit ? (page.at(-1)?.createdAt.toISOString() ?? null) : null
    };
}
