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

/** Somebody, as a friends list draws them. */
export interface FriendView {
    readonly id: string;
    readonly name: string;
    readonly email: string;
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
            requester: { select: { id: true, name: true, email: true } },
            addressee: { select: { id: true, name: true, email: true } }
        }
    });
    return rows
        .map((row) => (row.requester.id === userId ? row.addressee : row.requester))
        .sort((left, right) => left.name.localeCompare(right.name));
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
            requester: { select: { id: true, name: true, email: true } },
            addressee: { select: { id: true, name: true, email: true } }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        person: row.requesterId === userId ? row.addressee : row.requester,
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
        return;
    }

    await prisma.friendship.create({ data: { requesterId: userId, addresseeId: otherId } });
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
