/**
 * Finding a person on this instance.
 *
 * One search behind every picker that names somebody - a conversation, a friend
 * request - because the rule about who may be found is a privacy rule and must
 * not have two copies. What differs between the callers is one question: whether
 * the person also has to be able to receive a message.
 *
 * **Nothing is listed.** An empty box answers with an empty list, and so does a
 * single letter: a picker that fills itself with everybody on the instance the
 * moment it opens is a user directory, and an instance is not always a company
 * where everybody may know everybody.
 */

import { prisma, VISIBLE_USER } from "@polaris/db";
import { blockedBetween } from "@/lib/blocks";
import { discoverableBy } from "@/lib/privacy-service";
import { like } from "@/lib/rich-text/mention-service";

/**
 * The fewest characters that count as looking for somebody.
 *
 * Two, because one letter is not a search - it is the first page of a directory,
 * and paging a directory is what nobody here has agreed to.
 */
export const SHORTEST_SEARCH = 2;

export interface FoundPeople {
    readonly people: { id: string; name: string }[];
    /**
     * How many the searcher was allowed to find but cannot use here - today,
     * accounts without the chat. Never counts anybody privacy kept back: a
     * number is also an answer, and "3 accounts you may not know about matched"
     * is the answer the setting exists to withhold.
     */
    readonly withheld: number;
}

export async function findPeople(
    viewer: { id: string },
    query: string,
    options: {
        /** Whether to leave out anybody who cannot receive a message. False for
         *  a friend request, which is not one. */
        readonly reachableOnly: boolean;
        /** Resolves the second filter, so this module does not have to know what
         *  a capability is. */
        readonly reachable?: (userIds: readonly string[]) => Promise<Set<string>>;
        readonly limit?: number;
    }
): Promise<FoundPeople> {
    const limit = options.limit ?? 8;
    const term = query.trim();
    if (term.length < SHORTEST_SEARCH) return { people: [], withheld: 0 };

    const contains = like(term);
    const found = await prisma.user.findMany({
        where: {
            id: { not: viewer.id },
            ...VISIBLE_USER,
            OR: [{ name: contains }, { email: contains }, { username: contains }]
        },
        select: { id: true, name: true, username: true },
        orderBy: { name: "asc" },
        take: Math.min(limit * 4, 40)
    });

    // Findable first, then usable. The order matters for the count: somebody who
    // has hidden themselves is not "an account that cannot be written to", they
    // are not an account this search knows about at all.
    //
    // A block is read the same way rather than as a refusal, and in both
    // directions. Somebody who blocked this searcher is not a result they may
    // not use - they are not a result, and a count saying otherwise would be the
    // block announcing itself. Somebody this searcher blocked is left out for
    // the plainer reason that picking them would open a conversation their own
    // decision refuses to carry.
    const [visible, blocked] = await Promise.all([
        discoverableBy(
            { id: viewer.id, isAdmin: false },
            found.map((person) => person.id)
        ),
        blockedBetween(
            viewer.id,
            found.map((person) => person.id)
        )
    ]);
    const candidates = found.filter((person) => visible.has(person.id) && !blocked.has(person.id));

    const allowed =
        options.reachableOnly && options.reachable
            ? await options.reachable(candidates.map((person) => person.id))
            : null;
    const people = allowed ? candidates.filter((person) => allowed.has(person.id)) : candidates;

    return {
        people: people.slice(0, limit).map((person) => ({
            id: person.id,
            // The handle rather than the address when an account has no name.
            // A search that can be typed into by anybody is the last place to
            // hand one back - and it matches on the address above, so a result
            // shaped like one would confirm a guess.
            name: person.name || (person.username ? `@${person.username}` : "Somebody")
        })),
        withheld: candidates.length - people.length
    };
}
