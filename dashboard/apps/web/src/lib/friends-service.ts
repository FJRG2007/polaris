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

import { follow } from "@/lib/follow/follow";
import { blockedEitherWay } from "@/lib/blocks";
import { prisma, VISIBLE_USER } from "@polaris/db";
import { contactLines } from "@/lib/privacy-service";
import { notify } from "@/lib/notifications/dispatch";
import { wordsFor } from "@/lib/notifications/notice-words";

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
    /** What the asker wrote with it, if anything. */
    readonly note: string | null;
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

    const people = [
        ...asked.map((row) => row.addressee),
        ...wereAsked.map((row) => row.requester)
    ].sort(byName);
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
    return new Set(friendPartnerIds(rows, userId));
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
            note: true,
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
        askedAt: row.createdAt.toISOString(),
        note: row.note
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
export async function requestFriend(
    userId: string,
    otherId: string,
    note: string | null = null
): Promise<void> {
    if (userId === otherId) throw new FriendError("You are already yourself");

    const other = await prisma.user.findUnique({ where: { id: otherId }, select: { id: true } });
    if (!other) throw new FriendError("That account is gone");

    // Either direction, and nothing said about which. A request is a
    // notification with somebody's name on it, which is precisely what a block
    // is for; and asking to be friends with somebody you blocked yourself is a
    // contradiction the screen should not have to explain twice.
    if (await blockedEitherWay(userId, otherId)) throw new FriendError(CANNOT_ASK);

    // Whether they take requests from somebody like this, which is their
    // decision and not the asker's. Refused with the sentence a block gives, for
    // the same reason: a different one would say which of the two it was.
    //
    // Never as an administrator. Every other setting bends for one because an
    // administrator can read the database anyway; this one is not about reading,
    // it is about putting something on somebody's screen, and "nobody" that an
    // administrator walks through is not the setting it says it is.
    //
    // Reached at call time rather than imported: the privacy service asks this
    // module who somebody's friends are, and importing it back at the top would
    // close the loop.
    const { maySee } = await import("@/lib/privacy-service");
    if (!(await maySee(otherId, "friendRequests", { id: userId, isAdmin: false }))) {
        throw new FriendError(CANNOT_ASK);
    }

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
            data: { status: "accepted", respondedAt: new Date(), note: null }
        });
        // Their request is answered, so its alert has nothing left to ask.
        await dropFriendNotices(userId, otherId, { requestOnly: true });
        // The same thing accepting from the friends screen does: two people who
        // have agreed to be friends have already said the smaller thing
        // following says - see `respondToRequest`, where the reasoning lives.
        await Promise.all([
            follow("user", otherId, userId, "friend"),
            follow("user", userId, otherId, "friend")
        ]).catch(() => undefined);
        await ensureFriendDm(userId, otherId);
        await announce(otherId, userId, "accepted");
        return;
    }

    await prisma.friendship.create({ data: { requesterId: userId, addresseeId: otherId, note } });
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
    const t = await wordsFor(userId, "notices");
    const name = person?.name || (person?.username ? `@${person.username}` : "") || t("friends.somebody");
    await notify({
        userId,
        event: "account.friend",
        title: what === "asked" ? t("friends.asked", { name }) : t("friends.accepted", { name }),
        body: what === "asked" ? t("friends.askedBody") : t("friends.acceptedBody"),
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
export async function requestFriendByUsername(
    userId: string,
    username: string,
    note: string | null = null
): Promise<void> {
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

    await requestFriend(userId, other.id, note);
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
        // The row goes, and the note on it with it; so does the alert that
        // asked the other one to answer, which now points at nothing.
        await prisma.friendship.deleteMany({ where: { id: requestId, status: "pending" } });
        await dropFriendNotices(request.addresseeId, request.requesterId, { requestOnly: true });
        return;
    }
    // The note was written to be read before answering; once answered it is
    // nobody's business to keep.
    await prisma.friendship.update({
        where: { id: requestId },
        data: { status: "accepted", respondedAt: new Date(), note: null }
    });
    await dropFriendNotices(userId, request.requesterId, { requestOnly: true });

    /**
     * Friends follow each other.
     *
     * Two people who have just agreed to be friends have said the smaller thing
     * following says as well, so asking them to press it again would be asking
     * them to confirm something they have already answered. Both directions,
     * because a friendship is mutual and a one-way follow out of it would be an
     * asymmetry neither of them chose.
     *
     * Recorded as `friend` rather than `explicit`: neither of them pressed
     * Follow, and the row should not claim they did.
     *
     * Never fails the friendship. The friendship is the thing that happened; a
     * follow row that did not write is a button on a profile away from being put
     * right, and unfriending later leaves the follow alone - by then it is an
     * ordinary follow like any other, and taking it away silently would be the
     * product undoing something on somebody's behalf.
     */
    await Promise.all([
        follow("user", request.requesterId, userId, "friend"),
        follow("user", userId, request.requesterId, "friend")
    ]).catch(() => undefined);

    await ensureFriendDm(userId, request.requesterId);

    // The one who asked is the one waiting to hear.
    await announce(request.requesterId, userId, "accepted");
}

/**
 * Open the direct conversation two friends are now entitled to.
 *
 * Becoming friends is the moment a conversation between two people stops needing
 * to be asked for, so it is opened here rather than waiting for one of them to go
 * looking for the other in a picker. Both accept paths call this: `requestFriend`
 * when somebody asks a person who had already asked them, and `respondToRequest`
 * when a request is answered from the friends screen. One function for both,
 * because a rule with two implementations is a rule with one hole in it.
 *
 * Idempotent, by way of `openDirect` keying a one-to-one conversation on its
 * members: calling this twice, or for two people who already have a thread with
 * years of history in it, returns that thread and changes nothing.
 *
 * BOTH sides are checked rather than one. `openDirect` verifies that the people
 * being messaged may be messaged and takes the actor's own right for granted -
 * true of somebody pressing a button in a picker, and not true here, where nobody
 * pressed anything. A pair where either one cannot use chat gets no conversation
 * now and gets one the moment that changes; see `openMissingFriendDms`.
 *
 * Never fails the friendship, for the same reason the follow rows above are not
 * allowed to either: the friendship is the thing that happened, and a conversation
 * that did not open is one search box away from being opened by hand.
 *
 * Reached at call time rather than imported. `chat/messages.ts` imports this
 * module, so pulling chat in at the top would close the loop - the same reason the
 * privacy service is reached this way in `requestFriend`.
 */
export async function ensureFriendDm(oneId: string, otherId: string): Promise<void> {
    if (oneId === otherId) return;
    try {
        const [{ messageable }, { openDirect }] = await Promise.all([
            import("@/lib/chat/access"),
            import("@/lib/chat/chat-service")
        ]);
        const allowed = await messageable([oneId, otherId]);
        if (allowed.size !== 2) return;
        await openDirect({ id: oneId }, [otherId]);
    } catch {
        // A conversation that did not open is not a friendship that did not happen.
    }
}

/**
 * The other person in each friendship row, from one account's point of view.
 *
 * Pure, and tested, because a friendship is one row that can point either way and
 * the mistake available here returns the account its own id - which would then ask
 * for a conversation with itself, be refused by `openDirect`, and leave every real
 * conversation unopened with nothing on screen to say why.
 */
export function friendPartnerIds(
    rows: readonly { readonly requesterId: string; readonly addresseeId: string }[],
    selfId: string
): string[] {
    const partners = new Set<string>();
    for (const row of rows) {
        const other = row.requesterId === selfId ? row.addresseeId : row.requesterId;
        if (other !== selfId) partners.add(other);
    }
    return [...partners];
}

/**
 * Open the conversations an account's friendships are owed and do not have.
 *
 * The other half of `ensureFriendDm`. A pair becomes friends before either of them
 * necessarily has chat - somebody is invited as a guest, made friends with, and
 * given the run of the place a week later - and the conversation is owed from the
 * moment the second of those is true, not only at the moment of the friendship.
 * So this is what gets called when an account's access changes.
 *
 * Sequential rather than all at once. Each conversation is a row plus a change
 * published to whoever is listening, and an account with two hundred friends
 * should not turn one role change into two hundred simultaneous writes.
 *
 * Best-effort throughout: `ensureFriendDm` swallows its own failures, so a chat
 * that is unreachable cannot fail the role change that called this.
 */
export async function openMissingFriendDms(userId: string): Promise<void> {
    for (const partner of await friendIds(userId)) {
        await ensureFriendDm(userId, partner);
    }
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
    // "So-and-so accepted" in either bell is news that is no longer true.
    await Promise.all([dropFriendNotices(userId, otherId), dropFriendNotices(otherId, userId)]);
}

/**
 * End whatever request is waiting between two people, in either direction.
 *
 * For a block: a request is a notification with somebody's name on it, which is
 * exactly what a block is for, and one left open could still be accepted from
 * the friends screen. A friendship already made is left alone - that is the
 * friends list's decision, not the block's.
 */
export async function endPendingRequests(userId: string, otherId: string): Promise<void> {
    await prisma.friendship.deleteMany({
        where: {
            status: "pending",
            OR: [
                { requesterId: userId, addresseeId: otherId },
                { requesterId: otherId, addresseeId: userId }
            ]
        }
    });
    await Promise.all([
        dropFriendNotices(userId, otherId, { requestOnly: true }),
        dropFriendNotices(otherId, userId, { requestOnly: true })
    ]);
}

/** The most friend alerts about one person one bell is read for. One request
 *  and one acceptance is the normal case; this only bounds a strange one. */
const NOTICES_ABOUT_ONE = 50;

/**
 * Delete the friend alerts in one account's bell about one person.
 *
 * `requestOnly` limits it to the "wants to be added" alert, which is the one an
 * answered or withdrawn request leaves pointing at nothing. Best effort: a bell
 * that kept a stale line is not worth failing the answer over.
 */
async function dropFriendNotices(
    userId: string,
    personId: string,
    options: { requestOnly?: boolean } = {}
): Promise<void> {
    try {
        const rows = await prisma.notification.findMany({
            where: {
                userId,
                type: "account.friend",
                ...(options.requestOnly ? { actionRequired: true } : {}),
                metadata: { contains: personId }
            },
            select: { id: true, metadata: true },
            take: NOTICES_ABOUT_ONE
        });
        const ids = rows.filter((row) => notificationIsAbout(row.metadata, personId)).map((row) => row.id);
        if (ids.length > 0) await prisma.notification.deleteMany({ where: { id: { in: ids }, userId } });
    } catch (caught) {
        console.error("polaris: could not tidy friend alerts:", caught);
    }
}

/** How many request alerts one sweep pass reads. */
const SWEEP_PAGE = 200;

/** Where the last pass stopped. Per process and lost on restart, which only
 *  means the next pass starts from the oldest again. */
let sweepCursor: string | null = null;

/**
 * Drop "wants to be added" alerts whose request has ended.
 *
 * The answer paths delete their own alert now; this is for the ones written
 * before they did, and for any a failed tidy left behind. A page at a time in id
 * order, moving on each pass, so a table of millions is walked in bounded steps
 * and a page of still-open requests is never read twice in a row.
 */
export async function sweepEndedFriendRequestNotices(): Promise<{ removed: number }> {
    const rows = await prisma.notification.findMany({
        where: {
            type: "account.friend",
            actionRequired: true,
            ...(sweepCursor ? { id: { gt: sweepCursor } } : {})
        },
        orderBy: { id: "asc" },
        take: SWEEP_PAGE,
        select: { id: true, userId: true, metadata: true }
    });
    sweepCursor = rows.length === SWEEP_PAGE ? rows.at(-1)!.id : null;
    if (rows.length === 0) return { removed: 0 };

    const named = rows.flatMap((row) => {
        const personId = personIdOf(row.metadata);
        // An alert that names nobody cannot be matched to a request; it is left
        // alone rather than guessed at.
        return personId ? [{ id: row.id, userId: row.userId, personId }] : [];
    });
    if (named.length === 0) return { removed: 0 };
    const open = await prisma.friendship.findMany({
        where: {
            status: "pending",
            OR: named.map((row) => ({ requesterId: row.personId, addresseeId: row.userId }))
        },
        select: { requesterId: true, addresseeId: true }
    });
    const waiting = new Set(open.map((row) => `${row.addresseeId}:${row.requesterId}`));
    const ended = named.filter((row) => !waiting.has(`${row.userId}:${row.personId}`)).map((row) => row.id);
    if (ended.length === 0) return { removed: 0 };
    const gone = await prisma.notification.deleteMany({ where: { id: { in: ended } } });
    return { removed: gone.count };
}

/** The person a stored friend alert is about, or null when it names nobody. */
function personIdOf(metadata: string | null): string | null {
    if (!metadata) return null;
    try {
        const parsed: unknown = JSON.parse(metadata);
        const id = parsed && typeof parsed === "object" ? (parsed as { personId?: unknown }).personId : null;
        return typeof id === "string" ? id : null;
    } catch {
        return null;
    }
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
        const mine = unread
            .filter((row) => notificationIsAbout(row.metadata, personId))
            .map((row) => row.id);
        if (mine.length === 0) return;
        await prisma.notification.updateMany({
            where: { id: { in: mine } },
            data: { readAt: new Date() }
        });
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
    return personIdOf(metadata) === personId;
}
