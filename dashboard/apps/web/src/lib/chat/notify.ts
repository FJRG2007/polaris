/**
 * How loudly a conversation is allowed to interrupt somebody.
 *
 * The answer is two rows deep - the channel's, and the space's where the channel
 * has no answer of its own - and three different places need it: the toast a
 * message raises, the sound and the desktop notice that go with it, and the
 * notification an `@everyone` writes. Resolving it in each of them would be
 * three copies of a rule that has to agree.
 *
 * It is deliberately not the mute. A mute is a silence with an end and takes the
 * unread badge with it; this decides what interrupts and leaves the counting
 * alone. Both are checked, and either one is enough to stay quiet.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { channelMentions, extractReferences } from "@/components/rich-text/markdown";

/**
 * The level in force for one reader, per channel.
 *
 * Two reads whatever the number of channels: their membership rows, and the
 * preferences for whichever spaces those channels belong to. A channel with
 * neither is `all`, which is what nobody having chosen anything means.
 */
export async function notifyLevels(
    userId: string,
    channelIds: readonly string[]
): Promise<Map<string, core.ChatNotifyLevel>> {
    const ids = [...new Set(channelIds)];
    const levels = new Map<string, core.ChatNotifyLevel>();
    if (ids.length === 0) return levels;

    const [memberships, channels] = await Promise.all([
        prisma.chatChannelMember.findMany({
            where: { userId, channelId: { in: ids } },
            select: { channelId: true, notifyLevel: true }
        }),
        prisma.chatChannel.findMany({
            where: { id: { in: ids } },
            select: { id: true, spaceId: true }
        })
    ]);

    const spaceIds = [
        ...new Set(channels.map((row) => row.spaceId).filter((id): id is string => id !== null))
    ];
    const preferences = spaceIds.length
        ? await prisma.chatSpacePreference.findMany({
              where: { userId, spaceId: { in: spaceIds } },
              select: { spaceId: true, notifyLevel: true }
          })
        : [];

    const mine = new Map(memberships.map((row) => [row.channelId, row.notifyLevel]));
    const spaces = new Map(preferences.map((row) => [row.spaceId, row.notifyLevel]));
    for (const channel of channels) {
        levels.set(
            channel.id,
            core.resolveChatNotify(
                mine.get(channel.id),
                channel.spaceId ? spaces.get(channel.spaceId) : null
            )
        );
    }
    return levels;
}

/**
 * The people who have asked one conversation not to interrupt them at all.
 *
 * The same resolution as above, turned the other way round: one channel, many
 * readers. `mentions` is not in it - a message that names the room is a mention,
 * which is exactly what that level asks to be told about.
 */
export async function silencedIn(
    channelId: string,
    userIds: readonly string[]
): Promise<Set<string>> {
    const ids = [...new Set(userIds)];
    const silenced = new Set<string>();
    if (ids.length === 0) return silenced;

    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: { spaceId: true }
    });
    const [memberships, preferences] = await Promise.all([
        prisma.chatChannelMember.findMany({
            where: { channelId, userId: { in: ids } },
            select: { userId: true, notifyLevel: true }
        }),
        channel?.spaceId
            ? prisma.chatSpacePreference.findMany({
                  where: { spaceId: channel.spaceId, userId: { in: ids } },
                  select: { userId: true, notifyLevel: true }
              })
            : Promise.resolve([])
    ]);

    const mine = new Map(memberships.map((row) => [row.userId, row.notifyLevel]));
    const spaces = new Map(preferences.map((row) => [row.userId, row.notifyLevel]));
    for (const userId of ids) {
        if (core.resolveChatNotify(mine.get(userId), spaces.get(userId)) === "none") {
            silenced.add(userId);
        }
    }
    return silenced;
}

/** Nobody, for a reader whose teams have not been looked up because nothing
 *  needed them. */
const NO_TEAMS: ReadonlySet<string> = new Set<string>();

/**
 * The teams a reader is in, lowercased, ready to match a `@team` against.
 *
 * Read once for a whole announcement rather than once per message: a mention of
 * a team names everybody in it, which is the rule the notifications already
 * follow, and a level that missed it would leave somebody named at work with
 * nothing at all - Chat writes no record for a plain mention either.
 */
export async function readerTeams(userId: string): Promise<ReadonlySet<string>> {
    const rows = await prisma.teamMember.findMany({ where: { userId }, select: { teamId: true } });
    return new Set(rows.map((row) => row.teamId.toLowerCase()));
}

/**
 * Whether a message is one the reader asked to hear about at `mentions`.
 *
 * Their own name, their team's, or the room's - `@everyone` and `@here` are how
 * somebody addresses a channel, and a level that let them through unread would
 * be one nobody could use for the channel they are on call for.
 *
 * All of them go through the same parse the editor uses, so an address inside a
 * code fence is code rather than a ping. That parse is the expensive part and it
 * runs on every message of a busy room, so a body carrying neither a `@` nor an
 * address is ruled out before either one happens - which is nearly all of them.
 *
 * @param teamIds - The reader's teams, from `readerTeams`. Empty means a `@team`
 *   names nobody, which is the right answer when nothing looked them up.
 */
export function mentionsReader(
    body: string,
    userId: string,
    teamIds: ReadonlySet<string> = NO_TEAMS
): boolean {
    const written = body.includes("@");
    const addressed = body.includes("polaris:");
    if (!written && !addressed) return false;
    if (written && channelMentions(body).size > 0) return true;
    if (!addressed) return false;
    const me = userId.toLowerCase();
    return extractReferences(body).some((reference) =>
        reference.kind === "user"
            ? reference.id.toLowerCase() === me
            : reference.kind === "team" && teamIds.has(reference.id.toLowerCase())
    );
}
