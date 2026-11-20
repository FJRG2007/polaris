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
 * alone. Both are checked, and either one is enough to stay quiet - except that
 * a mention of the reader gets through a mute unless it holds mentions too,
 * where `none` silences it as well, as Discord's "Nothing" does.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { chatMutes } from "./app-mute";
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
 * @param author - The reader wrote it. Naming yourself is not being named, but
 *   `@everyone`, `@here` and your own team reach the one who sent them as much
 *   as anybody else, so only the reference to the reader by name is dropped.
 */
export function mentionsReader(
    body: string,
    userId: string,
    teamIds: ReadonlySet<string> = NO_TEAMS,
    author = false
): boolean {
    const written = body.includes("@");
    const addressed = body.includes("polaris:");
    if (!written && !addressed) return false;
    if (written && channelMentions(body).size > 0) return true;
    if (!addressed) return false;
    const me = userId.toLowerCase();
    return extractReferences(body).some((reference) =>
        reference.kind === "user"
            ? !author && reference.id.toLowerCase() === me
            : reference.kind === "team" && teamIds.has(reference.id.toLowerCase())
    );
}

/** Who is asking about a mute: one reader across conversations, or one
 *  conversation across readers. */
export type MuteLookup = (channelId: string, userId: string) => core.ChatMuteState;

/**
 * The mutes in force for these readers in these conversations, conversation's
 * and Chat's as a whole, for `core.chatMuteHolds` to decide on.
 *
 * Two reads whatever the size: the muted membership rows and the accounts'
 * holds. Called for one reader (a toast) or one conversation (a room
 * mention); with one reader the rows are narrowed to them, otherwise to the
 * muted rows of the conversations, which are the few.
 */
export async function muteStates(
    channelIds: readonly string[],
    userIds: readonly string[],
    now = new Date()
): Promise<MuteLookup> {
    const channels = [...new Set(channelIds)];
    const users = [...new Set(userIds)];
    if (channels.length === 0 || users.length === 0) return () => core.CHAT_UNMUTED;
    const [rows, app] = await Promise.all([
        prisma.chatChannelMember.findMany({
            where: {
                channelId: { in: channels },
                muted: true,
                ...(users.length === 1 ? { userId: users[0] } : {})
            },
            select: {
                channelId: true,
                userId: true,
                muted: true,
                mutedUntil: true,
                muteMentions: true
            }
        }),
        chatMutes(users, now)
    ]);
    const conversation = new Map(
        rows
            .filter((row) => core.muteInForce(row, now))
            .map((row) => [`${row.channelId}:${row.userId}`, row.muteMentions])
    );
    return (channelId, userId) => {
        const own = conversation.get(`${channelId}:${userId}`);
        const whole = app.get(userId);
        return {
            conversation: own !== undefined,
            conversationMentions: own ?? false,
            app: whole !== undefined,
            appMentions: whole?.mentions ?? false
        };
    };
}

/**
 * Which of these quoted messages the reader wrote, so a reply to them counts as
 * naming them - as a reply does in Discord, WhatsApp and Telegram. One read for
 * the whole batch.
 */
export async function repliesToReader(
    userId: string,
    replyToIds: readonly (string | null)[]
): Promise<Set<string>> {
    const ids = [...new Set(replyToIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Set();
    const rows = await prisma.chatMessage.findMany({
        where: { id: { in: ids }, authorId: userId },
        select: { id: true }
    });
    return new Set(rows.map((row) => row.id));
}
