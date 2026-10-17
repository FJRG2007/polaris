/**
 * The card drawn under a message that carries an invitation link.
 *
 * Kept apart from `invites.ts` so the message reader can use it without
 * importing the service that posts messages.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { ChatActor } from "./access";

/** What a card under a message says about one invitation, for this reader. */
export interface ChatInviteCard {
    readonly code: string;
    /** Null when the code names nothing or no longer opens: the card says the
     *  invite is invalid, and nothing about the space. */
    readonly spaceId: string | null;
    readonly spaceName: string;
    readonly spaceColor: string;
    readonly channelId: string | null;
    readonly usable: boolean;
    readonly member: boolean;
    readonly members: number;
    readonly online: number;
}

/** Seen within this long and not invisible: the window presence uses. */
const ONLINE_MS = 3 * 60_000;

/**
 * The cards for every invitation the messages on a page carry, in a fixed
 * number of queries for the whole page rather than some per message.
 */
export async function inviteCards(
    actor: ChatActor,
    codes: readonly string[]
): Promise<Map<string, ChatInviteCard>> {
    const wanted = [...new Set(codes)].slice(0, 50);
    const cards = new Map<string, ChatInviteCard>();
    if (wanted.length === 0) return cards;

    const rows = await prisma.chatSpaceInvite.findMany({
        where: { code: { in: wanted } },
        select: {
            code: true,
            expiresAt: true,
            maxUses: true,
            uses: true,
            revokedAt: true,
            channelId: true,
            channel: { select: { private: true } },
            space: {
                select: { id: true, name: true, color: true, archived: true, ownerId: true }
            }
        }
    });
    const usable = rows.filter((row) => !row.space.archived && core.inviteUsable(row));
    const spaceIds = [...new Set(usable.map((row) => row.space.id))];
    const since = new Date(Date.now() - ONLINE_MS);
    const [mine, counts, online] = spaceIds.length
        ? await Promise.all([
              prisma.chatSpaceMember.findMany({
                  where: { spaceId: { in: spaceIds }, userId: actor.id },
                  select: { spaceId: true }
              }),
              prisma.chatSpaceMember.groupBy({
                  by: ["spaceId"],
                  where: { spaceId: { in: spaceIds } },
                  _count: { _all: true }
              }),
              prisma.chatSpaceMember.groupBy({
                  by: ["spaceId"],
                  where: {
                      spaceId: { in: spaceIds },
                      user: {
                          presence: { not: "invisible" },
                          sessionStates: { some: { lastSeenAt: { gt: since } } }
                      }
                  },
                  _count: { _all: true }
              })
          ])
        : [[], [], []];
    const joined = new Set(mine.map((row) => row.spaceId));
    const total = new Map(counts.map((row) => [row.spaceId, row._count._all]));
    const around = new Map(online.map((row) => [row.spaceId, row._count._all]));

    for (const code of wanted) {
        const row = usable.find((entry) => entry.code === code);
        // A link that no longer opens says nothing about the space it named.
        if (!row) {
            cards.set(code, {
                code,
                spaceId: null,
                spaceName: "",
                spaceColor: "",
                channelId: null,
                usable: false,
                member: false,
                members: 0,
                online: 0
            });
            continue;
        }
        cards.set(code, {
            code,
            spaceId: row.space.id,
            spaceName: row.space.name,
            spaceColor: row.space.color,
            channelId: row.channelId && row.channel && !row.channel.private ? row.channelId : null,
            usable: true,
            member: joined.has(row.space.id) || row.space.ownerId === actor.id,
            // The owner holds no membership row.
            members: (total.get(row.space.id) ?? 0) + 1,
            online: around.get(row.space.id) ?? 0
        });
    }
    return cards;
}

/** Whether this code is a live invitation into this space - what lets
 *  somebody who is not in a space yet see its picture on an invite card. */
export async function inviteShowsSpace(code: string, spaceId: string): Promise<boolean> {
    const invite = await prisma.chatSpaceInvite.findUnique({
        where: { code },
        select: { spaceId: true, expiresAt: true, maxUses: true, uses: true, revokedAt: true }
    });
    return invite !== null && invite.spaceId === spaceId && core.inviteUsable(invite);
}
