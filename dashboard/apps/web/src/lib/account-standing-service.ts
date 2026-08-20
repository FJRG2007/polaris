/**
 * Where one account stands, worked out from what actually happened to it.
 *
 * Nothing here is a new record: there is no strikes table and there should not
 * be one. A moderator taking a message down after a report is already written
 * down - it is the report row, settled as `removed`, naming the person who wrote
 * it - and a second table saying the same thing would be a second thing to keep
 * in step. The same goes for what is limiting somebody right now: a timeout is a
 * moment on their membership row and a ban is a row in a space's ban list, and
 * both are read here rather than copied anywhere.
 *
 * The ladder itself is `accountStanding` in core, which is pure. This is the
 * part that needs a database.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import {
    accountStanding,
    ACCOUNT_STANDING_WINDOW_DAYS,
    type AccountStanding
} from "@polaris/core";

/** Something in force against an account, as its owner is shown it. */
export interface AccountRestriction {
    /** `timeout` ends by itself; `ban` does not. */
    readonly kind: "timeout" | "ban";
    /** The conversation or space it applies in, named the way its owner sees it. */
    readonly where: string;
    /** When it lifts, or null for one that does not lift on its own. */
    readonly until: Date | null;
}

export interface AccountStandingView {
    readonly standing: AccountStanding;
    /** How many things of theirs were taken down inside the window. */
    readonly upheld: number;
    /** When the window this counts over began. */
    readonly since: Date;
    /** What is actually stopping them doing something, right now. Usually none:
     *  a step on the ladder is a record, and this is a restriction. */
    readonly restrictions: AccountRestriction[];
}

export async function accountStandingFor(userId: string): Promise<AccountStandingView> {
    const now = new Date();
    const since = new Date(now.getTime() - ACCOUNT_STANDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [user, upheld, spaceTimeouts, channelTimeouts, bans] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { bannedAt: true } }),
        // Upheld rather than reported: anybody can report anything, and a
        // standing that moved on accusations is a standing anybody can push
        // somebody down. `removed` is a moderator having agreed.
        prisma.chatReport.count({
            where: { authorId: userId, status: "removed", handledAt: { gte: since } }
        }),
        prisma.chatSpaceMember.findMany({
            where: { userId, timeoutUntil: { gt: now } },
            select: { timeoutUntil: true, space: { select: { name: true } } }
        }),
        prisma.chatChannelMember.findMany({
            where: { userId, timeoutUntil: { gt: now } },
            select: { timeoutUntil: true, channel: { select: { name: true } } }
        }),
        prisma.chatSpaceBan.findMany({
            where: { userId },
            select: { space: { select: { name: true } } }
        })
    ]);

    const restrictions: AccountRestriction[] = [
        ...spaceTimeouts.map((row) => ({
            kind: "timeout" as const,
            where: row.space.name,
            until: row.timeoutUntil
        })),
        ...channelTimeouts.map((row) => ({
            kind: "timeout" as const,
            // A group has a name; the odd unnamed one is still a place.
            where: row.channel.name || "a conversation",
            until: row.timeoutUntil
        })),
        ...bans.map((row) => ({ kind: "ban" as const, where: row.space.name, until: null }))
    ];

    return {
        standing: accountStanding({ suspended: user?.bannedAt !== null && user?.bannedAt !== undefined, upheld }),
        upheld,
        since,
        restrictions
    };
}
