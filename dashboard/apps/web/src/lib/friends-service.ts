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

import { prisma } from "@polaris/db";
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

/** Everybody this account is friends with. */
export async function listFriends(userId: string): Promise<FriendView[]> {
    const rows = await prisma.friendship.findMany({
        where: {
            status: "accepted",
            OR: [{ requesterId: userId }, { addresseeId: userId }]
        },
        select: {
            requester: { select: { id: true, name: true, email: true, username: true } },
            addressee: { select: { id: true, name: true, email: true, username: true } }
        }
    });
    const people = rows.map((row) => (row.requester.id === userId ? row.addressee : row.requester));
    return (await drawn(userId, people)).sort((left, right) => left.name.localeCompare(right.name));
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
        actionRequired: what === "asked"
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
        where: { username: handle, bannedAt: null },
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
