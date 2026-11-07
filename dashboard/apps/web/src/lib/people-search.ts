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
 *
 * **Only friends autocomplete.** A few letters find a friend by their name or
 * their handle; anybody else is found only by what the operator's discovery
 * policy allows (`discovery-policy.ts`) - by default, typing their whole
 * username. A partial match on strangers is a directory with extra steps - two
 * letters at a time, it lists every account on the instance - which is why it is
 * an instance decision and off unless somebody turns it on.
 */

import { prisma, VISIBLE_USER } from "@polaris/db";
import type { Prisma } from "@polaris/db";
import { blockedBetween } from "@/lib/blocks";
import { friendIds } from "@/lib/friends-service";
import { discoverableBy } from "@/lib/privacy-service";
import { getSetting, setSetting } from "@/lib/setting-store";
import { like } from "@/lib/rich-text/mention-service";
import {
    DEFAULT_DISCOVERY_POLICY,
    DISCOVERY_POLICY_KEY,
    readDiscoveryPolicy,
    type DiscoveryPolicy
} from "@/lib/discovery-policy";

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

/** The operator's discovery policy, with the defaults for anything unset. */
export async function discoveryPolicy(): Promise<DiscoveryPolicy> {
    return readDiscoveryPolicy(await getSetting(DISCOVERY_POLICY_KEY));
}

export async function setDiscoveryPolicy(policy: DiscoveryPolicy): Promise<void> {
    await setSetting(DISCOVERY_POLICY_KEY, JSON.stringify(policy));
}

/**
 * How `term` may match somebody who is neither a friend nor a colleague, by the
 * operator's policy. Nothing under `SHORTEST_SEARCH` characters, and nothing
 * partial on fewer than that either, so a single letter after "@" is not a page
 * of the directory.
 *
 * The address only ever as a whole, and only to find - whether it is printed
 * back is still the account's own email setting, decided by whoever renders it.
 */
export function strangerMatches(term: string, policy: DiscoveryPolicy): Prisma.UserWhereInput[] {
    if (term.length < SHORTEST_SEARCH) return [];
    // Usernames and addresses are stored lowercased, so an exact match is a
    // plain equality.
    const handle = term.replace(/^@/, "").toLowerCase();
    return [
        ...(policy.usernameExact && handle ? [{ username: handle }] : []),
        ...(policy.usernamePartial && handle.length >= SHORTEST_SEARCH
            ? [{ username: like(handle) }]
            : []),
        ...(policy.namePartial ? [{ name: like(term) }] : []),
        ...(policy.emailExact && term.includes("@", 1) ? addressMatches(term.toLowerCase()) : [])
    ];
}

/** An account by its main address or one it added and proved, as a whole. */
function addressMatches(address: string): Prisma.UserWhereInput[] {
    return [
        { email: address },
        { emails: { some: { email: address, verifiedAt: { not: null } } } }
    ];
}

/**
 * Who a search for `term` may match: a friend by any part of their name or
 * handle, and anybody else only by what the discovery policy allows - by
 * default their whole username.
 */
export function matchingPeople(
    term: string,
    friends: readonly string[],
    policy: DiscoveryPolicy = DEFAULT_DISCOVERY_POLICY
): { OR: Prisma.UserWhereInput[] } {
    const contains = like(term);
    return {
        OR: [
            ...(friends.length > 0
                ? [{ id: { in: [...friends] }, OR: [{ name: contains }, { username: contains }] }]
                : []),
            ...strangerMatches(term, policy)
        ]
    };
}

/**
 * Which of these accounts `viewerId` may be shown: their own "who can find me"
 * allows it, and there is no block between the two in either direction.
 *
 * The second half of every people search, kept here so a field that names
 * somebody and the friend search cannot drift apart. A block is read in both
 * directions and as absence rather than refusal - see `findPeople`.
 */
export async function findableBy(
    viewerId: string,
    userIds: readonly string[]
): Promise<Set<string>> {
    const wanted = [...new Set(userIds)];
    if (wanted.length === 0) return new Set();
    const [visible, blocked] = await Promise.all([
        discoverableBy({ id: viewerId, isAdmin: false }, wanted),
        blockedBetween(viewerId, wanted)
    ]);
    return new Set(wanted.filter((id) => visible.has(id) && !blocked.has(id)));
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

    const [friends, policy] = await Promise.all([friendIds(viewer.id), discoveryPolicy()]);
    const found = await prisma.user.findMany({
        where: {
            id: { not: viewer.id },
            ...VISIBLE_USER,
            ...matchingPeople(term, [...friends], policy)
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
    const findable = await findableBy(
        viewer.id,
        found.map((person) => person.id)
    );
    const candidates = found.filter((person) => findable.has(person.id));

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
            // hand one back.
            name: person.name || (person.username ? `@${person.username}` : "Somebody")
        })),
        withheld: candidates.length - people.length
    };
}

/**
 * Accounts an instance administrator is looking for, by name, email or username.
 *
 * Not the search above: an administrator already reads the whole directory, so
 * nobody's own say over who can find them applies here, and banned or disabled
 * accounts are found too - they are what a rule or a policy is often written
 * about. It is still a page of matches rather than a list of everybody. Only for
 * callers that have checked the caller is an administrator.
 */
export async function findAccountsAsAdmin(
    query: string,
    limit = 20
): Promise<{ id: string; name: string }[]> {
    const term = query.trim();
    if (term.length < SHORTEST_SEARCH) return [];
    const contains = like(term);
    return prisma.user.findMany({
        where: { OR: [{ name: contains }, { email: contains }, { username: contains }] },
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: Math.min(Math.max(limit, 1), 50)
    });
}
