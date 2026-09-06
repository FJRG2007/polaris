/**
 * The address book nobody has to maintain.
 *
 * A contact list somebody has to keep up to date is a contact list that is
 * wrong, so this one is not kept: it is observed. Every address that arrives in
 * or leaves a mailbox is counted, and the composer completes from what it has
 * seen, ranked by how much of the person's actual correspondence it accounts
 * for.
 *
 * Sent counts for more than received, deliberately and by a wide margin.
 * Everybody has heard from a newsletter two hundred times and has never written
 * to it, and an address book that puts it first is one nobody uses twice.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

/** How much a message sent to somebody is worth against one received from them,
 *  when the two are ranked together. */
const SENT_WEIGHT = 5;

/** Addresses that are machinery rather than people. Counting them is what puts
 *  `noreply@` at the top of somebody's address book. */
const NEVER_COLLECTED = /^(?:no-?reply|do-?not-?reply|donotreply|bounce|mailer-daemon|postmaster|notifications?|automated?)[+.@-]/i;

function collectible(entry: core.MailAddress): boolean {
    return Boolean(entry.address) && !NEVER_COLLECTED.test(entry.address);
}

/**
 * Count everybody in one message.
 *
 * Which side counts depends on which folder it landed in: a message in Sent is
 * somebody this person writes to, and one in the inbox is somebody who writes to
 * them. A message in Sent counts its recipients and nothing else, because the
 * sender is the mailbox itself.
 */
export async function rememberContacts(
    accountId: string,
    folderRole: string,
    message: {
        readonly from: readonly core.MailAddress[];
        readonly to: readonly core.MailAddress[];
        readonly cc: readonly core.MailAddress[];
    }
): Promise<void> {
    const outgoing = folderRole === "sent" || folderRole === "drafts";
    const people = core.dedupeAddresses(
        outgoing ? [...message.to, ...message.cc] : message.from
    ).filter(collectible);
    if (people.length === 0) return;

    for (const person of people) {
        await prisma.mailContact.upsert({
            where: { accountId_address: { accountId, address: person.address } },
            update: {
                lastSeenAt: new Date(),
                // A name only ever arrives, never leaves: a message that carried
                // no display name must not blank the one somebody already has.
                ...(person.name.trim() ? { name: person.name.trim() } : {}),
                ...(outgoing ? { sentCount: { increment: 1 } } : { receivedCount: { increment: 1 } })
            },
            create: {
                accountId,
                address: person.address,
                name: person.name.trim(),
                sentCount: outgoing ? 1 : 0,
                receivedCount: outgoing ? 0 : 1
            }
        });
    }
}

export interface ContactSuggestion {
    readonly address: string;
    readonly name: string;
}

/**
 * Who to offer as somebody types into a recipient field.
 *
 * Matched on both halves - the name and the address - because people search for
 * a colleague by surname as often as by login. Ranked in this process rather
 * than by the database, because the ranking is a weighted sum of two columns and
 * expressing that as an index would be a stored value that goes stale; the set
 * being ranked is capped first, so it is a sort of a few dozen rows.
 */
export async function suggestContacts(
    accountIds: readonly string[],
    query: string,
    limit = 8
): Promise<ContactSuggestion[]> {
    const needle = query.trim();
    if (needle.length < 2 || accountIds.length === 0) return [];
    const rows = await prisma.mailContact.findMany({
        where: {
            accountId: { in: [...accountIds] },
            hidden: false,
            OR: [
                { address: { contains: needle, mode: "insensitive" } },
                { name: { contains: needle, mode: "insensitive" } }
            ]
        },
        select: { address: true, name: true, sentCount: true, receivedCount: true, lastSeenAt: true },
        take: 60
    });

    const byAddress = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
        // The same person can be in two mailboxes. Their counts add up: they are
        // one person and the composer offers them once.
        const held = byAddress.get(row.address);
        if (!held) {
            byAddress.set(row.address, row);
            continue;
        }
        byAddress.set(row.address, {
            address: row.address,
            name: held.name || row.name,
            sentCount: held.sentCount + row.sentCount,
            receivedCount: held.receivedCount + row.receivedCount,
            lastSeenAt: held.lastSeenAt > row.lastSeenAt ? held.lastSeenAt : row.lastSeenAt
        });
    }

    return [...byAddress.values()]
        .sort((left, right) => {
            const score = (row: (typeof rows)[number]) => row.sentCount * SENT_WEIGHT + row.receivedCount;
            const bySize = score(right) - score(left);
            return bySize !== 0 ? bySize : right.lastSeenAt.getTime() - left.lastSeenAt.getTime();
        })
        .slice(0, limit)
        .map((row) => ({ address: row.address, name: row.name }));
}

/** Take somebody out of completion without forgetting they exist, so they do
 *  not come back the next time they send something. */
export async function hideContact(accountId: string, address: string): Promise<void> {
    await prisma.mailContact.updateMany({
        where: { accountId, address: address.trim().toLowerCase() },
        data: { hidden: true }
    });
}
