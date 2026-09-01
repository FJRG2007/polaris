/**
 * Who knows whom.
 *
 * A friendship is mutual and is one row: somebody asks, somebody accepts, and
 * from then on the direction is only a record of who asked first. Everything
 * that reads it looks at both columns.
 *
 * It exists because privacy needs a middle setting. "Everybody or nobody" is not
 * a useful answer to who may see your photo or that you read a message, and
 * "friends" is the group people already understand. Nothing else in Polaris
 * depends on it - a friendship grants no access to anything, and that is
 * deliberate: a relationship that also carried permissions would be two ideas
 * wearing one name.
 */

import { prisma, VISIBLE_USER } from "@polaris/db";
import { blockedEitherWay } from "@/lib/blocks";
import { contactLines } from "@/lib/privacy-service";
import { notify } from "@/lib/notifications/dispatch";

/** Somebody, as a friends list draws them. */
export interface FriendView {
    readonly id: string;
    readonly name: string;
    /** Their address if they show it to this account, their handle otherwise.
     *  Being friends is not consent to hand over an address - the setting for
     *  that is on their own privacy screen, and it may well say nobody. */
    readonly contact: string;
}

/** A request waiting on somebody. */
export interface FriendRequestView {
    readonly id: string;
    readonly person: FriendView;
    /** Whether this account is the one who asked, which decides whether the row
     *  offers Accept or Cancel. */
    readonly outgoing: boolean;
    readonly askedAt: string;
}

/** Said where a block is what refuses, in both directions and naming neither.
 *  A sentence that distinguished the two cases would tell somebody they have
 *  been blocked, which is the one thing a block must not do. */
const CANNOT_ASK = "You cannot send that request";

export class FriendError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FriendError";
    }
}

/** The people, with whatever each of them lets this account see. */
async function drawn(
    viewerId: string,
    people: readonly { id: string; name: string; email: string; username: string | null }[]
): Promise<FriendView[]> {
    const contacts = await contactLines({ id: viewerId, isAdmin: false }, people);
    return people.map((person) => ({
        id: person.id,
        name: person.name,
        contact: contacts.get(person.id) ?? ""
    }));
}

/** How many friends one page carries. */
export const FRIENDS_PAGE_SIZE = 50;

/** Where a page stopped: the last person on it. Name and id together, because
 *  two people can share a name and a cursor that named only the name would skip
 *  one of them or repeat both. */
export interface FriendCursor {
    readonly name: string;
    readonly id: string;
}

export interface FriendsPage {
    readonly items: FriendView[];
    /** Pass back as `after` for the next page. Null when the list ended. */
    readonly cursor: FriendCursor | null;
}

/** Whether a person sorts after the cursor, as a Prisma filter. */
function afterCursor(cursor: FriendCursor) {
    return {
        OR: [{ name: { gt: cursor.name } }, { name: cursor.name, id: { gt: cursor.id } }]
    };
}

/** Name then id, which is the one order both halves of the list are read in. */
function byName(left: { id: string; name: string }, right: { id: string; name: string }): number {
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

/**
 * One page of friends, in alphabetical order.
 *
 * A friendship is one row that names two people and does not say which of them
 * is "the other one" - that depends on who is reading. So the page is two
 * queries, one per direction, each ordered and cut by the database on the name
 * of the person this account would see; they are then merged, which is cheap
 * because both arrive sorted and only one page of each is asked for.
 *
 * The alternative - reading every friendship and sorting in memory - is what
 * this replaces, and it is fine at ten friends and a full table scan at ten
 * thousand.
 */
export async function listFriendsPage(
    userId: string,
    options: { after?: FriendCursor | null; limit?: number } = {}
): Promise<FriendsPage> {
    const limit = Math.min(Math.max(options.limit ?? FRIENDS_PAGE_SIZE, 1), 200);
    const after = options.after ?? null;
    const person = { select: { id: true, name: true, email: true, username: true } };
    const beyond = after ? afterCursor(after) : {};

    const [asked, wereAsked] = await Promise.all([
        prisma.friendship.findMany({
            where: { status: "accepted", requesterId: userId, addressee: beyond },
            orderBy: [{ addressee: { name: "asc" } }, { addresseeId: "asc" }],
            take: limit + 1,
            select: { addressee: person }
        }),
        prisma.friendship.findMany({
            where: { status: "accepted", addresseeId: userId, requester: beyond },
            orderBy: [{ requester: { name: "asc" } }, { requesterId: "asc" }],
            take: limit + 1,
            select: { requester: person }
        })
    ]);

    const people = [...asked.map((row) => row.addressee), ...wereAsked.map((row) => row.requester)].sort(
        byName
    );
    const page = people.slice(0, limit);
    const last = page.at(-1);
    return {
        items: await drawn(userId, page),
        cursor: people.length > limit && last ? { name: last.name, id: last.id } : null
    };
}

/** Just the ids, for the privacy check that asks about one person. */
export async function friendIds(userId: string): Promise<Set<string>> {
    const rows = await prisma.friendship.findMany({
        where: {
            status: "accepted",
            OR: [{ requesterId: userId }, { addresseeId: userId }]
        },
        select: { requesterId: true, addresseeId: true }
    });
    return new Set(
        rows.map((row) => (row.requesterId === userId ? row.addresseeId : row.requesterId))
    );
}

/** Whether these two are friends. */
export async function areFriends(left: string, right: string): Promise<boolean> {
    if (left === right) return true;
    const row = await prisma.friendship.findFirst({
        where: {
            status: "accepted",
            OR: [
                { requesterId: left, addresseeId: right },
                { requesterId: right, addresseeId: left }
            ]
        },
        select: { id: true }
    });
    return row !== null;
}

/** Everything waiting, in both directions. */
export async function listRequests(userId: string): Promise<FriendRequestView[]> {
    const rows = await prisma.friendship.findMany({
        where: {
            status: "pending",
            OR: [{ requesterId: userId }, { addresseeId: userId }]
        },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            createdAt: true,
            requesterId: true,
            requester: { select: { id: true, name: true, email: true, username: true } },
            addressee: { select: { id: true, name: true, email: true, username: true } }
        }
    });
    const people = await drawn(
        userId,
        rows.map((row) => (row.requesterId === userId ? row.addressee : row.requester))
    );
    return rows.map((row, index) => ({
        id: row.id,
        person: people[index]!,
        outgoing: row.requesterId === userId,
        askedAt: row.createdAt.toISOString()
    }));
}

/**
 * Ask somebody.
 *
 * Asking somebody who has already asked you accepts theirs instead of storing a
 * second row pointing the other way. Two people reaching for each other at the
 * same moment is not an error state, and leaving both requests open would leave
 * each waiting for the other.
 */
export async function requestFriend(userId: string, otherId: string): Promise<void> {
    if (userId === otherId) throw new FriendError("You are already yourself");

    const other = await prisma.user.findUnique({ where: { id: otherId }, select: { id: true } });
    if (!other) throw new FriendError("That account is gone");

    // Either direction, and nothing said about which. A request is a
    // notification with somebody's name on it, which is precisely what a block
    // is for; and asking to be friends with somebody you blocked yourself is a
    // contradiction the screen should not have to explain twice.
    if (await blockedEitherWay(userId, otherId)) throw new FriendError(CANNOT_ASK);

    const existing = await prisma.friendship.findFirst({
        where: {
            OR: [
                { requesterId: userId, addresseeId: otherId },
                { requesterId: otherId, addresseeId: userId }
            ]
        },
        select: { id: true, status: true, requesterId: true }
    });

    if (existing?.status === "accepted") return;
    if (existing?.status === "pending") {
        if (existing.requesterId === userId) return;
        await prisma.friendship.update({
            where: { id: existing.id },
            data: { status: "accepted", respondedAt: new Date() }
        });
        await announce(otherId, userId, "accepted");
        return;
    }

    await prisma.friendship.create({ data: { requesterId: userId, addresseeId: otherId } });
    await announce(otherId, userId, "asked");
}

/** Where a friend request is answered. */
const FRIENDS_PATH = "/account/friends";

/**
 * Tell somebody about it.
 *
 * A request that sits on a screen nobody has open is a request nobody answers,
 * and the person who sent it is left wondering whether they typed the username
 * wrong. Never fails the thing it is announcing: the friendship is the point and
 * the alert is the courtesy.
 */
async function announce(
    userId: string,
    aboutId: string,
    what: "asked" | "accepted"
): Promise<void> {
    const person = await prisma.user.findUnique({
        where: { id: aboutId },
        select: { name: true, username: true }
    });
    // Never the address. An alert naming somebody is still a screen showing one
    // account something about another, and this one goes out by mail as well.
    const name = person?.name || (person?.username ? `@${person.username}` : "") || "Somebody";
    await notify({
        userId,
        event: "account.friend",
        title: what === "asked" ? `${name} wants to be added` : `${name} added you`,
        body:
            what === "asked"
                ? "Answer it on your friends page."
                : "You can now see whatever they show their friends.",
        href: FRIENDS_PATH,
        // Only the request is waiting on anybody. Being accepted is news.
        actionRequired: what === "asked",
        // Who it is about, so it can be answered by something other than reading
        // it. Talking to the person is the case that matters - see
        // `clearFriendNoticeAbout`. The id and nothing else: a notification's
        // metadata is not a place to keep a copy of somebody's name.
        metadata: { personId: aboutId }
    }).catch(() => undefined);
}

/**
 * Ask somebody whose username you were given.
 *
 * The way in for an account that has taken itself out of every search. It has to
 * exist, because "you cannot be found" and "you cannot be reached" are different
 * settings and only the first is `friends`: a username is a thing a person hands
 * out deliberately, one at a time, and this is what makes handing it out mean
 * something.
 *
 * **The answer never says whether the account exists.** A different reply for a
 * hit and a miss turns this into a way to test names one at a time until one
 * lands, which is the whole thing the setting exists to prevent. So the caller
 * gets one sentence either way, and a request is only actually stored when there
 * was somebody to store it against.
 *
 * Exact, and case-insensitively so, since usernames are stored lowercase and
 * somebody typing one from a note may capitalise it.
 */
export async function requestFriendByUsername(userId: string, username: string): Promise<void> {
    const handle = username.trim().replace(/^@/, "").toLowerCase();
    if (!handle) return;

    const other = await prisma.user.findFirst({
        where: { username: handle, ...VISIBLE_USER },
        select: { id: true }
    });
    // Nothing to say and nothing to do. Deliberately indistinguishable from the
    // case below, from the outside.
    if (!other || other.id === userId) return;
    // And a block returns the same silence rather than the refusal `requestFriend`
    // would raise. This path answers a typed username, so a refusal here would be
    // a way to learn that the name exists AND that the account behind it blocked
    // you - the two facts this whole function is written to withhold.
    if (await blockedEitherWay(userId, other.id)) return;

    await requestFriend(userId, other.id);
}

/**
 * Answer a request.
 *
 * Only the person who was asked may accept. Turning one down deletes the row
 * rather than recording a refusal: a stored "no" is a thing that has to be
 * cleaned up, and it would stop them ever being asked again by an account that
 * has since become somebody they know.
 */
export async function respondToRequest(
    userId: string,
    requestId: string,
    accept: boolean
): Promise<void> {
    const request = await prisma.friendship.findUnique({
        where: { id: requestId },
        select: { addresseeId: true, requesterId: true, status: true }
    });
    if (!request || request.status !== "pending") return;

    // Either side may withdraw; only the one asked may accept.
    if (accept && request.addresseeId !== userId) {
        throw new FriendError("Only the person asked can accept");
    }
    if (!accept && request.addresseeId !== userId && request.requesterId !== userId) {
        throw new FriendError("That is not yours to answer");
    }

    if (!accept) {
        await prisma.friendship.delete({ where: { id: requestId } });
        return;
    }
    await prisma.friendship.update({
        where: { id: requestId },
        data: { status: "accepted", respondedAt: new Date() }
    });
    // The one who asked is the one waiting to hear.
    await announce(request.requesterId, userId, "accepted");
}

/** Stop being friends. Either of them, without telling the other - and it is
 *  the row that goes, so it can be asked again later. */
export async function removeFriend(userId: string, otherId: string): Promise<void> {
    await prisma.friendship.deleteMany({
        where: {
            OR: [
                { requesterId: userId, addresseeId: otherId },
                { requesterId: otherId, addresseeId: userId }
            ]
        }
    });
}

/**
 * Mark the "so-and-so added you" notice read, because you are talking to them.
 *
 * The whole content of that notification is that a person is now connected to
 * you. Opening a conversation with them tells you that more directly than the
 * notification does - you are looking at their name, in a thread with them - so
 * a bell still counting it is a bell counting something you demonstrably know.
 * It is the same reasoning `notify` already applies when it marks an alert read
 * because the page it points at is open, one step further out: the thing that
 * answers this one is not that screen, it is the conversation.
 *
 * Only the accepted one. A request still waiting on an answer is not answered by
 * chatting - it is answered by accepting or declining, and clearing it here
 * would hide a decision somebody still has to make. It is told apart by
 * `actionRequired`, which is set for exactly that case and for no other.
 *
 * Best effort, and never the reason a message fails to send.
 */
export async function clearFriendNoticeAbout(userId: string, personId: string): Promise<void> {
    try {
        const unread = await prisma.notification.findMany({
            where: { userId, type: "account.friend", readAt: null, actionRequired: false },
            select: { id: true, metadata: true }
        });
        const mine = unread.filter((row) => notificationIsAbout(row.metadata, personId)).map((row) => row.id);
        if (mine.length === 0) return;
        await prisma.notification.updateMany({ where: { id: { in: mine } }, data: { readAt: new Date() } });
    } catch {
        // A tidied bell is not worth failing a conversation over.
    }
}

/**
 * Whether a stored notification is about this person.
 *
 * The column is text holding JSON, so it is parsed defensively: a row written by
 * an older build carries no metadata at all, and one that cannot be read is one
 * this cannot claim anything about. Neither is an error - both simply mean the
 * notification stays where it is.
 */
export function notificationIsAbout(metadata: string | null, personId: string): boolean {
    if (!metadata) return false;
    try {
        const parsed: unknown = JSON.parse(metadata);
        if (!parsed || typeof parsed !== "object") return false;
        return (parsed as { personId?: unknown }).personId === personId;
    } catch {
        return false;
    }
}
