/**
 * Deciding not to hear from somebody.
 *
 * Not a chat feature, which is why it does not live in `lib/chat`: the same
 * decision has to hold wherever one account can reach another - a direct
 * message, a mention, a telephone ringing, a friend request, the search box
 * that finds people in the first place. A block that only covered messages
 * would be a block somebody walks around by pressing Call.
 *
 * Three rules run through all of it.
 *
 * **It is one-sided and it is not announced.** The person blocked is never
 * told, and nothing they see changes. They write into the conversation and it
 * lands in a room nobody is reading; every messenger worth the name behaves
 * this way, because a block that announces itself is one people are afraid to
 * use. The one thing that must never happen is a different error for a block
 * than for anything else, which would tell them exactly what happened.
 *
 * **Both directions are refused.** Somebody who blocked a person is not offered
 * a conversation with them either - not because their decision binds them, but
 * because the alternative is a screen that lets you write into a room the other
 * person cannot answer in. Lifting the block is one menu item away, and that is
 * the honest way back.
 *
 * **It is not moderation.** A timeout is a room deciding somebody may not speak
 * in it and ends by itself. A ban is a door, closed by whoever runs a space. A
 * block is a person's own decision about their own attention, lasts until they
 * lift it, and applies in every room at once - including the ones nobody
 * moderates.
 *
 * What it deliberately does **not** do is take somebody out of a shared room.
 * Blocking a colleague does not remove either of you from the channel you both
 * work in; their messages are collapsed for the person who blocked them and
 * they are not offered a way to reach them privately. Emptying a room over a
 * personal decision would be a moderation act wearing a privacy name.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

export class BlockError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BlockError";
    }
}

/** Somebody on a block list, as the screen that lifts one draws them. */
export interface BlockedPerson {
    readonly id: string;
    readonly name: string;
    readonly blockedAt: string;
}

/**
 * Stop hearing from somebody.
 *
 * Idempotent: blocking a person already blocked is not an error, because the
 * menu that offers it can be a moment out of date and the outcome is the one
 * that was asked for either way.
 */
export async function block(userId: string, otherId: string): Promise<void> {
    if (userId === otherId) throw new BlockError("You cannot block yourself");

    const other = await prisma.user.findUnique({ where: { id: otherId }, select: { id: true } });
    if (!other) throw new BlockError("That account is gone");

    const held = await prisma.userBlock.count({ where: { blockerId: userId } });
    // Counted before the write and only over this account's own list. The
    // ceiling is not a rule anybody meets; it is what stops a list every reach
    // check reads from growing without a bound.
    if (held >= core.MOST_BLOCKED) {
        throw new BlockError(
            `You have blocked ${core.MOST_BLOCKED} accounts, which is as many as Polaris keeps. Unblock somebody first.`
        );
    }

    await prisma.userBlock.upsert({
        where: { blockerId_blockedId: { blockerId: userId, blockedId: otherId } },
        update: {},
        create: { blockerId: userId, blockedId: otherId }
    });
}

/** Let them through again. Also idempotent, and for the same reason. */
export async function unblock(userId: string, otherId: string): Promise<void> {
    await prisma.userBlock.deleteMany({ where: { blockerId: userId, blockedId: otherId } });
}

/** Everybody this account has blocked, newest first - which is the order they
 *  will be looked for in, since the one somebody wants to lift is usually the
 *  one they set most recently. */
export async function listBlocked(userId: string): Promise<BlockedPerson[]> {
    const rows = await prisma.userBlock.findMany({
        where: { blockerId: userId },
        orderBy: { createdAt: "desc" },
        select: {
            createdAt: true,
            blocked: { select: { id: true, name: true, username: true } }
        }
    });
    return rows.map((row) => ({
        id: row.blocked.id,
        // The handle rather than the address when an account has no name, the
        // same fallback the people search uses: a list one account can read
        // about another is not the place to hand an address over.
        name: row.blocked.name || (row.blocked.username ? `@${row.blocked.username}` : "Somebody"),
        blockedAt: row.createdAt.toISOString()
    }));
}

/**
 * Which of these this account has blocked.
 *
 * The reader's own decision only, which is what draws a collapsed message and
 * what the menu reads to know whether to offer Block or Unblock. Not the same
 * question as `blockedBetween`, and using this one where that is meant is the
 * bug worth watching for: it would let somebody who blocked you keep reaching
 * you.
 */
export async function blockedBy(userId: string, otherIds: readonly string[]): Promise<Set<string>> {
    const wanted = [...new Set(otherIds)].filter((id) => id !== userId);
    if (wanted.length === 0) return new Set();
    const rows = await prisma.userBlock.findMany({
        where: { blockerId: userId, blockedId: { in: wanted } },
        select: { blockedId: true }
    });
    return new Set(rows.map((row) => row.blockedId));
}

/**
 * Which of these have blocked this account.
 *
 * The mirror of `blockedBy`, and the one to reach for when the question is
 * "who must not be told about this" rather than "what must this reader not be
 * shown": a mention, a telephone ringing, an alert. The two are one query apart
 * and confusing them is silent in both directions, which is why they are named
 * for who decided rather than for what happens.
 */
export async function blockersOf(
    userId: string,
    otherIds: readonly string[]
): Promise<Set<string>> {
    const wanted = [...new Set(otherIds)].filter((id) => id !== userId);
    if (wanted.length === 0) return new Set();
    const rows = await prisma.userBlock.findMany({
        where: { blockedId: userId, blockerId: { in: wanted } },
        select: { blockerId: true }
    });
    return new Set(rows.map((row) => row.blockerId));
}

/**
 * Which of these cannot be reached, in either direction.
 *
 * The question every path that puts two people in touch has to ask: a block set
 * by the other person is what makes them unreachable, and one set by this
 * account is what keeps the app from offering a conversation it would then
 * refuse to carry.
 */
export async function blockedBetween(
    userId: string,
    otherIds: readonly string[]
): Promise<Set<string>> {
    const wanted = [...new Set(otherIds)].filter((id) => id !== userId);
    if (wanted.length === 0) return new Set();
    const rows = await prisma.userBlock.findMany({
        where: {
            OR: [
                { blockerId: userId, blockedId: { in: wanted } },
                { blockedId: userId, blockerId: { in: wanted } }
            ]
        },
        select: { blockerId: true, blockedId: true }
    });
    return new Set(rows.map((row) => (row.blockerId === userId ? row.blockedId : row.blockerId)));
}

/** Whether these two can reach each other at all. The single-person form of
 *  `blockedBetween`, kept separate because most callers hold one id and a set
 *  round-trip reads as more than it is. */
export async function blockedEitherWay(userId: string, otherId: string): Promise<boolean> {
    if (userId === otherId) return false;
    const row = await prisma.userBlock.findFirst({
        where: {
            OR: [
                { blockerId: userId, blockedId: otherId },
                { blockerId: otherId, blockedId: userId }
            ]
        },
        select: { blockerId: true }
    });
    return row !== null;
}
