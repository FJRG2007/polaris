/**
 * What two people have in common.
 *
 * The two questions a profile answers about somebody you do not know well: who
 * do we both know, and where do we both already are. Together they are what
 * turns a name into a person - "three friends in common" is the difference
 * between a stranger and somebody you have simply not met yet, and it is why
 * every product with profiles draws them.
 *
 * One module because both are asked in the same two places - the page and the
 * panel beside a direct message, which are the same profile drawn twice - and
 * two copies would eventually disagree about what counts.
 *
 * **Nothing here is a disclosure either side has not already made.** A friend in
 * common is somebody both of them are friends with, and each of them can already
 * see their own list; a space in common is a room both are standing in, whose
 * roster each of them can already read. What is deliberately NOT answered is the
 * rest of either list, which is what the follower setting governs.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { friendIds } from "@/lib/friends-service";

/** Somebody both of them know. */
export interface MutualPerson {
    readonly id: string;
    readonly name: string;
    readonly username: string;
}

/** A room both of them are in. */
export interface MutualSpace {
    readonly id: string;
    readonly name: string;
    readonly color: string;
}

export interface Mutuals {
    readonly friends: MutualPerson[];
    readonly spaces: MutualSpace[];
}

/** How many of each are worth carrying to a screen. The count is the point and
 *  the faces are the illustration; past a handful it is a list nobody reads. */
export const MOST_MUTUAL = 12;

/**
 * The friends two people share.
 *
 * Both lists, intersected here rather than in the database: a friendship is one
 * row naming two people with no "the other one" column, so asking for "friends
 * of A who are also friends of B" is two reads either way - and these are the
 * two reads every other caller already makes.
 *
 * An account with no username is left out: the list is a list of links to
 * profiles, and there is nowhere to send anybody for an account without a
 * handle.
 */
export async function mutualFriends(
    viewerId: string,
    personId: string
): Promise<{ people: MutualPerson[]; total: number }> {
    if (viewerId === personId) return { people: [], total: 0 };
    const [mine, theirs] = await Promise.all([friendIds(viewerId), friendIds(personId)]);
    const shared = [...mine].filter((id) => theirs.has(id));
    if (shared.length === 0) return { people: [], total: 0 };

    const found = await prisma.user.findMany({
        where: { id: { in: shared }, bannedAt: null, username: { not: null } },
        orderBy: { name: "asc" },
        take: MOST_MUTUAL,
        select: { id: true, name: true, username: true }
    });
    return {
        people: found.map((person) => ({
            id: person.id,
            name: person.name,
            username: person.username ?? ""
        })),
        // Counted from the intersection rather than from the page: "and 4 more"
        // has to be the truth about the whole set, not about what fitted.
        total: shared.length
    };
}

/**
 * The chat spaces two people are both in.
 *
 * Owning one counts as being in it: the owner is not a member row - the same
 * arrangement an organization uses - so a query that only read the roster would
 * tell somebody they share no space with the person whose space they are in.
 *
 * Archived spaces are left out. A room nobody is using is not something the two
 * of them have in common today, and it is the one that would otherwise be at the
 * top of the list.
 */
export async function mutualSpaces(
    viewerId: string,
    personId: string
): Promise<{ spaces: MutualSpace[]; total: number }> {
    if (viewerId === personId) return { spaces: [], total: 0 };

    const inBoth = (userId: string) => ({
        archived: false,
        OR: [{ ownerId: userId }, { members: { some: { userId } } }]
    });

    const shared = await prisma.chatSpace.findMany({
        where: { AND: [inBoth(viewerId), inBoth(personId)] },
        orderBy: { name: "asc" },
        select: { id: true, name: true, color: true }
    });

    return { spaces: shared.slice(0, MOST_MUTUAL), total: shared.length };
}

/** Both answers at once, which is how both screens ask for them. */
export async function mutualsBetween(viewerId: string, personId: string): Promise<{
    friends: { people: MutualPerson[]; total: number };
    spaces: { spaces: MutualSpace[]; total: number };
}> {
    const [friends, spaces] = await Promise.all([
        mutualFriends(viewerId, personId),
        mutualSpaces(viewerId, personId)
    ]);
    return { friends, spaces };
}
