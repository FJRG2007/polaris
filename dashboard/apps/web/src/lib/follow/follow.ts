/**
 * Who hears about something, for any something.
 *
 * The third of the concerns that only Tasks had. A task decided who to tell from
 * its watchers; a service had no answer at all, so a deploy that failed told its
 * owner and nobody else - not the person who spent the afternoon on it, not the
 * one who asked to be told when it came back.
 *
 * The module answers one question - who - and deliberately does not send
 * anything. Delivery is `lib/notifications/dispatch`, and what is worth telling
 * somebody about belongs to the app that owns the subject.
 *
 * `follow` is idempotent on purpose: it is called from paths that mean "make
 * sure this person hears about it" (commenting, being assigned) as much as from
 * a switch somebody pressed, and those must not fail when they are already
 * following. The reason is only recorded the first time, so pressing Follow
 * after having commented does not rewrite why - it is already true.
 */

import { prisma, type Prisma } from "@polaris/db";
import type { ActivitySubject } from "@/lib/activity/activity";

/** The same vocabulary of subjects the history and the discussion use. */
export type FollowSubject = ActivitySubject;

/** How somebody came to be following. Shown, never acted on.
 *
 *  `friend` is the one that is not about a subject somebody worked on: accepting
 *  a friendship makes the two of them follow each other, and recording that as
 *  `explicit` would say they pressed a button neither of them pressed. */
export type FollowReason = "explicit" | "commented" | "assigned" | "created" | "friend";

/** Start following, or confirm that they already are. */
export async function follow(
    subjectType: FollowSubject,
    subjectId: string,
    userId: string,
    reason: FollowReason = "explicit",
    client: Prisma.TransactionClient = prisma
): Promise<void> {
    await client.follow.upsert({
        where: { subjectType_subjectId_userId: { subjectType, subjectId, userId } },
        // Already following: the reason they first came to be is still the true
        // one, so nothing is rewritten.
        update: {},
        create: { subjectType, subjectId, userId, reason }
    });
}

/** Stop. Silent when they were not following, which is what a toggle needs. */
export async function unfollow(
    subjectType: FollowSubject,
    subjectId: string,
    userId: string
): Promise<void> {
    await prisma.follow.deleteMany({ where: { subjectType, subjectId, userId } });
}

export async function isFollowing(
    subjectType: FollowSubject,
    subjectId: string,
    userId: string
): Promise<boolean> {
    const row = await prisma.follow.findUnique({
        where: { subjectType_subjectId_userId: { subjectType, subjectId, userId } },
        select: { userId: true }
    });
    return row !== null;
}

/**
 * Everybody following this, minus one person - almost always whoever caused
 * whatever is about to be announced, who does not need telling about their own
 * action.
 */
export async function followers(
    subjectType: FollowSubject,
    subjectId: string,
    except: string | null = null
): Promise<string[]> {
    const rows = await prisma.follow.findMany({
        where: { subjectType, subjectId },
        select: { userId: true }
    });
    const people = new Set(rows.map((row) => row.userId));
    if (except) people.delete(except);
    return [...people];
}

/** With the reason, for a screen that lists who is following and why. */
export async function followerDetails(
    subjectType: FollowSubject,
    subjectId: string
): Promise<{ userId: string; reason: string }[]> {
    return prisma.follow.findMany({
        where: { subjectType, subjectId },
        select: { userId: true, reason: true },
        orderBy: { createdAt: "asc" }
    });
}

/** Everything one person follows, for their own account screen. */
export async function followedBy(
    userId: string,
    subjectType?: FollowSubject
): Promise<{ subjectType: string; subjectId: string; reason: string }[]> {
    return prisma.follow.findMany({
        where: { userId, ...(subjectType ? { subjectType } : {}) },
        select: { subjectType: true, subjectId: true, reason: true },
        orderBy: { createdAt: "desc" }
    });
}

/** Drop the followers of something, for whatever deletes the subject. */
export async function forget(
    subjectType: FollowSubject,
    subjectId: string | readonly string[],
    client: Prisma.TransactionClient = prisma
): Promise<void> {
    const ids = typeof subjectId === "string" ? [subjectId] : [...subjectId];
    if (ids.length === 0) return;
    await client.follow.deleteMany({ where: { subjectType, subjectId: { in: ids } } });
}
