/**
 * Spaces, channels and who is in them.
 *
 * Everything here takes an actor and answers through `access.ts` first, without
 * exception: there is no "internal" entry point that skips the check because the
 * caller already knows. Messages live next door in `messages.ts` - the split is
 * where the rail ends and the conversation begins, which is also where the read
 * volume changes by two orders of magnitude.
 */

import { can } from "@polaris/auth";
import * as core from "@polaris/core";
import { publishChatChange } from "./live";
import { groupOwnerId } from "./ownership";
import { prisma, type Prisma } from "@polaris/db";
import { blockedBetween, blockedBy } from "@/lib/blocks";
import { nicknamesFor } from "@/lib/contact-names";
import { discardAvatars } from "@/lib/avatar-service";
import { discardChannelFiles } from "./attachments";
import { postNotice, postSpaceNotice } from "./notices";
import {
    ChatAccessError,
    ChatRuleError,
    channelAccess,
    messageable,
    picturesAllowed,
    reachableSpaceIds,
    requireChannel,
    requireSpace,
    spaceAccess,
    type ChatActor
} from "./access";

/** A space as the rail draws it. */
export interface ChatSpaceView {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly color: string;
    readonly visibility: core.ChatSpaceVisibility;
    readonly orgId: string | null;
    readonly orgName: string | null;
    readonly archived: boolean;
    /** What this reader may do in it, so the UI hides what it would refuse. */
    readonly access: "member" | "admin" | "owner";
    /** How much of it may interrupt this reader, and what every channel in it
     *  means by "follow the server". Nothing to do with the mute on a
     *  conversation, which is a silence with an end. */
    readonly notifyLevel: core.ChatNotifyLevel;
}

/** A heading inside a space. */
export interface ChatCategoryView {
    readonly id: string;
    readonly spaceId: string;
    readonly name: string;
}

/** A conversation in the rail: a channel, or a direct message. */
export interface ChatChannelView {
    readonly id: string;
    readonly spaceId: string | null;
    /** The heading it sits under, or null for the ones above the first one. */
    readonly categoryId: string | null;
    readonly kind: core.ChatChannelKind;
    /** For a channel, its name. For a direct message, who is in it - resolved
     *  here because "who is in it" is the name, and the client has no roster. */
    readonly name: string;
    readonly topic: string;
    readonly private: boolean;
    readonly archived: boolean;
    readonly lastMessageAt: string | null;
    /** How many messages this reader has not seen. Zero for a channel they have
     *  never opened and nothing has happened in. */
    readonly unread: number;
    readonly muted: boolean;
    /** How much of this conversation is worth interrupting for. `inherit` is
     *  whatever its space says, and is what a channel says until somebody has
     *  chosen otherwise. Separate from the mute below it, and it leaves the
     *  unread count alone: it decides what interrupts, not what is counted. */
    readonly notifyLevel: core.ChatChannelNotifyLevel;
    /** Whether this reader keeps it at the top of their list. Theirs alone -
     *  pinning a conversation says nothing to the other people in it. */
    readonly pinned: boolean;
    /** When the quiet ends, or null when it does not - either because the
     *  conversation is not muted or because it was muted with no end. */
    readonly mutedUntil: string | null;
    /** Whether this reader administers the conversation, which is what decides
     *  whether the screen offers them anything only a moderator may do. Always
     *  false in a direct message, where everybody in one is equal in it. */
    readonly mayAdminister: boolean;
    /** Whether this reader may take somebody else's message out of it. The same
     *  as administering it, plus the person whose group it is - a group has no
     *  administrators, so without this nobody could do anything about what is
     *  posted into one. */
    readonly mayModerate: boolean;
    /** Whether this reader may put a picture on it - the space's people for a
     *  channel, whoever started it for a group. Only decides what the screen
     *  offers; the route that stores the bytes asks the same question again. */
    readonly mayPicture: boolean;
    /** Who runs a group, so the screen can offer them the things only they may
     *  do. Null for everything that is not a group. */
    readonly ownerId: string | null;
    /** Whether the owner has let the rest of the group change how it looks. */
    readonly membersMayEdit: boolean;
    /** How long somebody waits between messages here, in seconds. Zero is off.
     *  Read by the composer so the wait is shown while it applies rather than
     *  discovered by being refused. */
    readonly slowmode: number;
    /** The other people in a direct message, for the avatars beside it. Empty
     *  for a named channel, where the name is the whole label. */
    readonly others: readonly { id: string; name: string }[];
    /**
     * Whether this reader has blocked the person on the other end of a
     * one-to-one conversation. Always false anywhere else.
     *
     * Carried so the composer can say so and offer to lift it, rather than
     * taking a message and refusing it. Only the reader's own decision: a block
     * held against them is not theirs to be told about, and this field never
     * says anything about one.
     */
    readonly blocked: boolean;
}

export interface ChatMemberView {
    readonly userId: string;
    readonly name: string;
    readonly role: string;
}

/** How many unread messages a badge counts up to before it says "more". Reading
 *  past this is somebody scrolling, not somebody catching up on a number. */
const UNREAD_CAP = 99;

/** Said the same way wherever it is refused, because it is one situation and the
 *  next step is the same: an administrator switches the chat on for them. */
const NO_CHAT = "Somebody there does not have the chat turned on";

/**
 * Said wherever a block is what refuses, and deliberately vague.
 *
 * One sentence for both directions and no name in it. Which of the two people
 * decided, and which person it was, are the two things this must not give away:
 * a refusal that says "they have blocked you" is the block telling the person
 * it was set against, and one that names who in a group of five is the same
 * leak with an extra step.
 */
const NO_REACH = "You cannot start that conversation";

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

/** Every space this person can reach, ordered as the rail shows them. */
export async function listSpaces(actor: ChatActor): Promise<ChatSpaceView[]> {
    const ids = await reachableSpaceIds(actor);
    if (ids.size === 0) return [];

    const [spaces, memberships, preferences] = await Promise.all([
        prisma.chatSpace.findMany({
            where: { id: { in: [...ids] } },
            orderBy: [{ order: "asc" }, { createdAt: "asc" }],
            select: {
                id: true,
                name: true,
                description: true,
                color: true,
                visibility: true,
                orgId: true,
                archived: true,
                ownerId: true,
                org: { select: { name: true } }
            }
        }),
        prisma.chatSpaceMember.findMany({
            where: { userId: actor.id, spaceId: { in: [...ids] } },
            select: { spaceId: true, role: true }
        }),
        prisma.chatSpacePreference.findMany({
            where: { userId: actor.id, spaceId: { in: [...ids] } },
            select: { spaceId: true, notifyLevel: true }
        })
    ]);

    const roles = new Map(memberships.map((row) => [row.spaceId, row.role]));
    const levels = new Map(preferences.map((row) => [row.spaceId, row.notifyLevel]));
    return spaces.map((space) => ({
        id: space.id,
        name: space.name,
        description: space.description,
        color: space.color,
        visibility: space.visibility as core.ChatSpaceVisibility,
        orgId: space.orgId,
        orgName: space.org?.name ?? null,
        archived: space.archived,
        access:
            space.ownerId === actor.id
                ? "owner"
                : roles.get(space.id) === "admin"
                  ? "admin"
                  : "member",
        // Nothing stored is "all", which is also what a stored word this
        // version does not know means: the column is free text.
        notifyLevel: core.resolveChatNotify(null, levels.get(space.id))
    }));
}

/**
 * Start a space, with a general channel already in it.
 *
 * The channel is not a convenience: a space with no channel is a room with no
 * doors, and the first thing anybody does with an empty one is create exactly
 * this. Making them do it by hand is asking them to guess what Polaris wanted.
 */
export async function createSpace(
    actor: ChatActor,
    input: core.ChatSpaceCreateInput
): Promise<string> {
    if (input.orgId) {
        const membership = await prisma.organizationMember.findFirst({
            where: { orgId: input.orgId, userId: actor.id },
            select: { id: true }
        });
        const owned = await prisma.organization.findFirst({
            where: { id: input.orgId, ownerId: actor.id },
            select: { id: true }
        });
        if (!membership && !owned) throw new ChatAccessError("You are not in that organization");
    }

    return prisma.$transaction(async (tx) => {
        const space = await tx.chatSpace.create({
            data: {
                ownerId: actor.id,
                orgId: input.orgId ?? null,
                name: input.name,
                description: input.description,
                visibility: input.visibility
            },
            select: { id: true }
        });
        await tx.chatChannel.create({
            data: { spaceId: space.id, name: "general", kind: "text", createdById: actor.id }
        });
        return space.id;
    });
}

export async function updateSpace(
    actor: ChatActor,
    input: core.ChatSpaceUpdateInput
): Promise<void> {
    await requireSpace(actor, input.spaceId, "admin");
    await prisma.chatSpace.update({
        where: { id: input.spaceId },
        data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
            ...(input.archived !== undefined ? { archived: input.archived } : {})
        }
    });
}

/** Only the owner. An admin can run a space; ending it is a different question,
 *  and the same answer Polaris gives everywhere else. */
export async function deleteSpace(actor: ChatActor, spaceId: string): Promise<void> {
    const space = await prisma.chatSpace.findUnique({
        where: { id: spaceId },
        select: { ownerId: true }
    });
    if (!space || space.ownerId !== actor.id) {
        throw new ChatAccessError("Only the owner can delete a space");
    }
    // Every channel's files, before the rows that say where they are cascade
    // away with the space.
    const channels = await prisma.chatChannel.findMany({
        where: { spaceId },
        select: { id: true }
    });
    await discardChannelFiles(channels.map((channel) => channel.id));
    // The pictures go the same way and for the same reason: the rows naming them
    // cascade with the space, and a cascade takes rows, not bytes.
    for (const channel of channels) await discardAvatars("channel", channel.id);
    await discardAvatars("space", spaceId);
    await prisma.chatSpace.delete({ where: { id: spaceId } });
}

export async function listSpaceMembers(
    actor: ChatActor,
    spaceId: string
): Promise<ChatMemberView[]> {
    await requireSpace(actor, spaceId);
    const [space, members] = await Promise.all([
        prisma.chatSpace.findUnique({
            where: { id: spaceId },
            select: { ownerId: true, owner: { select: { name: true } } }
        }),
        prisma.chatSpaceMember.findMany({
            where: { spaceId },
            orderBy: { createdAt: "asc" },
            select: { userId: true, role: true, user: { select: { name: true } } }
        })
    ]);
    if (!space) return [];
    return [
        { userId: space.ownerId, name: space.owner.name, role: "owner" },
        ...members.map((row) => ({ userId: row.userId, name: row.user.name, role: row.role }))
    ];
}

export async function addSpaceMembers(
    actor: ChatActor,
    spaceId: string,
    userIds: readonly string[]
): Promise<void> {
    await requireSpace(actor, spaceId, "admin");
    const space = await prisma.chatSpace.findUnique({
        where: { id: spaceId },
        select: { ownerId: true }
    });
    // The owner is never a member row, so adding them would create a second
    // answer to what they may do.
    const asked = [...new Set(userIds)].filter((id) => id !== space?.ownerId);
    // A ban is only a ban if it is checked where people are let in. Skipped
    // rather than refused: adding five people of whom one is barred should add
    // the four, not fail and leave whoever pressed it guessing which.
    const barred = await bannedFrom(spaceId, asked);
    const wanted = asked.filter((id) => !barred.has(id));
    if (wanted.length === 0) return;

    // Who is actually new, worked out before the write rather than counted
    // after it: `createMany` skips the duplicates silently, and a notice saying
    // somebody joined a space they have been in for a month is worse than none.
    const already = new Set(
        (
            await prisma.chatSpaceMember.findMany({
                where: { spaceId, userId: { in: wanted } },
                select: { userId: true }
            })
        ).map((row) => row.userId)
    );
    const fresh = wanted.filter((userId) => !already.has(userId));

    await prisma.chatSpaceMember.createMany({
        data: wanted.map((userId) => ({ spaceId, userId })),
        skipDuplicates: true
    });
    for (const userId of fresh) {
        await postSpaceNotice(spaceId, "added", { subjectId: userId, byId: actor.id });
    }
    publishChatChange({
        channelId: spaceId,
        kind: "channels",
        actorId: actor.id,
        audience: wanted
    });
}

/**
 * Leaving a space, or being turned out of one.
 *
 * @param quietly - Leave without the space being told. Only honoured for
 *   somebody leaving of their own accord: an administrator removing somebody
 *   cannot also decide that the room does not get to know, because the people
 *   left behind are the ones who need the line.
 */
export async function removeSpaceMember(
    actor: ChatActor,
    spaceId: string,
    userId: string,
    quietly = false
): Promise<void> {
    // Leaving is always allowed; removing somebody else takes an admin.
    if (userId !== actor.id) await requireSpace(actor, spaceId, "admin");
    else await requireSpace(actor, spaceId);

    await prisma.$transaction(async (tx) => {
        await tx.chatSpaceMember.deleteMany({ where: { spaceId, userId } });
        // Their private-channel rows in this space go too, or they would keep
        // reaching a room inside a space they are no longer in.
        const channels = await tx.chatChannel.findMany({
            where: { spaceId },
            select: { id: true }
        });
        await tx.chatChannelMember.deleteMany({
            where: { userId, channelId: { in: channels.map((row) => row.id) } }
        });
    });
    const own = userId === actor.id;
    if (!own || !quietly) {
        await postSpaceNotice(spaceId, own ? "left" : "removed", {
            subjectId: userId,
            byId: actor.id
        });
    }
    publishChatChange({
        channelId: spaceId,
        kind: "channels",
        actorId: actor.id,
        audience: [userId]
    });
}

/** A ban, as the list that lifts them draws it. */
export interface ChatBanView {
    readonly userId: string;
    readonly name: string;
    readonly reason: string;
    /** Who decided, or null once that account is gone. */
    readonly byName: string | null;
    readonly at: string;
}

/**
 * Keep somebody out of a space.
 *
 * Removing them is only half of it - without the row they walk back in through
 * the next invitation, and whoever removed them finds out by seeing them talking
 * again. So this takes them out and writes down that they may not come back, in
 * one transaction: a ban that half-applied would be either a removal nobody
 * recorded or a record of somebody still in the room.
 *
 * Only a space. A group is people who got there by invitation from somebody
 * already in it - there is no door to stand at, so taking somebody out of one is
 * all there is to do.
 *
 * Announced in the space, like a removal is. A room where people quietly
 * disappear is a room nobody trusts, and the alternative to saying so is
 * everybody working it out from an absence.
 */
export async function banFromSpace(
    actor: ChatActor,
    spaceId: string,
    userId: string,
    reason = ""
): Promise<void> {
    await requireSpace(actor, spaceId, "admin");
    if (userId === actor.id) throw new ChatRuleError("You cannot ban yourself");
    const space = await prisma.chatSpace.findUnique({
        where: { id: spaceId },
        select: { ownerId: true }
    });
    // The owner is not somebody an administrator gets to decide about. Without
    // this, any admin could take the space from whoever made it.
    if (space?.ownerId === userId) throw new ChatRuleError("That is the owner of this space");

    await prisma.$transaction(async (tx) => {
        await tx.chatSpaceBan.upsert({
            where: { spaceId_userId: { spaceId, userId } },
            create: { spaceId, userId, byId: actor.id, reason: reason.trim().slice(0, 300) },
            update: { byId: actor.id, reason: reason.trim().slice(0, 300) }
        });
        await tx.chatSpaceMember.deleteMany({ where: { spaceId, userId } });
        const channels = await tx.chatChannel.findMany({
            where: { spaceId },
            select: { id: true }
        });
        await tx.chatChannelMember.deleteMany({
            where: { userId, channelId: { in: channels.map((row) => row.id) } }
        });
    });

    await postSpaceNotice(spaceId, "banned", { subjectId: userId, byId: actor.id });
    publishChatChange({
        channelId: spaceId,
        kind: "channels",
        actorId: actor.id,
        audience: [userId]
    });
}

/** Let somebody back in. Deleting the row is the whole of it - they are not put
 *  back in the space, because being allowed in and being in are different things
 *  and only they can decide the second. */
export async function liftSpaceBan(
    actor: ChatActor,
    spaceId: string,
    userId: string
): Promise<void> {
    await requireSpace(actor, spaceId, "admin");
    await prisma.chatSpaceBan.deleteMany({ where: { spaceId, userId } });
}

/** Who is kept out of a space, for the screen that lifts them. */
export async function listSpaceBans(actor: ChatActor, spaceId: string): Promise<ChatBanView[]> {
    await requireSpace(actor, spaceId, "admin");
    const rows = await prisma.chatSpaceBan.findMany({
        where: { spaceId },
        orderBy: { createdAt: "desc" },
        select: {
            userId: true,
            reason: true,
            createdAt: true,
            user: { select: { name: true } },
            by: { select: { name: true } }
        }
    });
    return rows.map((row) => ({
        userId: row.userId,
        name: row.user.name,
        reason: row.reason,
        byName: row.by?.name ?? null,
        at: row.createdAt.toISOString()
    }));
}

/** Whether somebody is barred from a space. Asked wherever anybody is let in,
 *  which is what makes a ban survive being forgotten about. */
export async function bannedFrom(
    spaceId: string,
    userIds: readonly string[]
): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await prisma.chatSpaceBan.findMany({
        where: { spaceId, userId: { in: [...userIds] } },
        select: { userId: true }
    });
    return new Set(rows.map((row) => row.userId));
}

/**
 * Stop somebody talking for a while, without taking them out of the room.
 *
 * A moment rather than a flag, so it ends on its own. A timeout somebody has to
 * remember to lift is a timeout that becomes a ban by accident, which is a thing
 * everybody who has ever run a room has done at least once.
 *
 * In a space it holds everywhere in that space, which is what separates it from
 * a per-room annoyance; in a group it holds in the group. Nobody who may
 * moderate the room is held by one - see `channelAccess`.
 *
 * @param minutes - How long, or zero to lift it.
 */
export async function timeOutMember(
    actor: ChatActor,
    where: { spaceId?: string; channelId?: string },
    userId: string,
    minutes: number
): Promise<void> {
    if (userId === actor.id) throw new ChatRuleError("You cannot time yourself out");
    const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;

    if (where.spaceId) {
        await requireSpace(actor, where.spaceId, "admin");
        const space = await prisma.chatSpace.findUnique({
            where: { id: where.spaceId },
            select: { ownerId: true }
        });
        if (space?.ownerId === userId) throw new ChatRuleError("That is the owner of this space");
        await prisma.chatSpaceMember.updateMany({
            where: { spaceId: where.spaceId, userId },
            data: { timeoutUntil: until }
        });
        if (until) {
            await postSpaceNotice(where.spaceId, "timedOut", { subjectId: userId, byId: actor.id });
        }
        publishChatChange({ channelId: where.spaceId, kind: "channels", actorId: actor.id });
        return;
    }

    const channelId = where.channelId;
    if (!channelId) throw new ChatRuleError("There is nowhere to do that");
    const access = await requireChannel(actor, channelId);
    if (!access.mayModerate) throw new ChatAccessError("You cannot do that here");
    await prisma.chatChannelMember.updateMany({
        where: { channelId, userId },
        data: { timeoutUntil: until }
    });
    publishChatChange({ channelId, kind: "channels", actorId: actor.id });
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * Every conversation this person can reach, newest activity first.
 *
 * Direct messages and channels come back in one list because they are one list
 * in the rail, and the caller groups them by `kind` and `spaceId` rather than
 * asking twice for two halves of the same answer.
 */
export async function listChannels(actor: ChatActor): Promise<ChatChannelView[]> {
    const spaces = await reachableSpaceIds(actor);
    const [memberships, administered] = await Promise.all([
        prisma.chatChannelMember.findMany({
            where: { userId: actor.id },
            select: {
                channelId: true,
                lastReadAt: true,
                muted: true,
                mutedUntil: true,
                notifyLevel: true,
                pinnedAt: true,
                role: true
            }
        }),
        administeredSpaceIds(actor)
    ]);
    const mine = new Map(memberships.map((row) => [row.channelId, row]));

    const channels = await prisma.chatChannel.findMany({
        where: {
            OR: [
                { id: { in: memberships.map((row) => row.channelId) } },
                ...(spaces.size ? [{ spaceId: { in: [...spaces] }, private: false }] : [])
            ]
        },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: {
            id: true,
            spaceId: true,
            categoryId: true,
            kind: true,
            name: true,
            topic: true,
            private: true,
            archived: true,
            lastMessageAt: true,
            ownerId: true,
            createdById: true,
            membersMayEdit: true,
            slowmode: true,
            members: { select: { userId: true, user: { select: { name: true } } } }
        }
    });
    if (channels.length === 0) return [];

    const unread = await unreadCounts(actor, channels, mine);
    // What this reader calls people, over what those people are called. A direct
    // message is named after who is in it, so a nickname has to reach the list
    // itself and not only the messages inside it.
    const called = await nicknamesFor(
        actor.id,
        channels.flatMap((channel) => channel.members.map((member) => member.userId))
    );
    // One read for the whole rail, and only over the people in one-to-one
    // conversations: a block does not close a group or a channel, so asking
    // about their members would be asking a question nothing here answers.
    const shut = await blockedBy(
        actor.id,
        channels
            .filter((channel) => channel.kind === "dm")
            .flatMap((channel) => channel.members.map((member) => member.userId))
    );

    return channels.map((channel) => {
        const others = channel.members
            .filter((member) => member.userId !== actor.id)
            .map((member) => ({
                id: member.userId,
                name: called.get(member.userId) ?? member.user.name
            }));
        const membership = mine.get(channel.id);
        const mayAdminister = Boolean(
            channel.spaceId &&
                (administered.has(channel.spaceId) || mine.get(channel.id)?.role === "admin")
        );
        return {
            id: channel.id,
            spaceId: channel.spaceId,
            categoryId: channel.categoryId,
            kind: channel.kind as core.ChatChannelKind,
            // A group that has been named keeps it; one that has not is called
            // after the people in it, which is what it is.
            name: channel.spaceId ? channel.name : channel.name || directName(others),
            topic: channel.topic,
            private: channel.private,
            archived: channel.archived,
            lastMessageAt: channel.lastMessageAt?.toISOString() ?? null,
            unread: unread.get(channel.id) ?? 0,
            // Worked out rather than read: a mute with an end that has passed is
            // not a mute, and nothing runs to clear the flag.
            muted: membership ? core.muteInForce(membership) : false,
            mutedUntil: membership?.mutedUntil?.toISOString() ?? null,
            notifyLevel: channelNotifyOf(membership?.notifyLevel),
            pinned: membership?.pinnedAt !== null && membership?.pinnedAt !== undefined,
            mayAdminister,
            // The one standing a group confers: its owner may take a message
            // out of it. Not `mayAdminister`, which would also hand them the
            // channel controls a group does not have.
            mayModerate:
                mayAdminister || (channel.kind === "group" && groupOwnerId(channel) === actor.id),
            // Whether the screen offers this reader the picture control. The
            // same predicate the route enforces with, asked here so the rule
            // has one implementation rather than two that drift.
            mayPicture: picturesAllowed({ ...channel, mayAdminister }, actor.id),
            ownerId: groupOwnerId(channel),
            membersMayEdit: channel.membersMayEdit,
            slowmode: channel.slowmode,
            others: channel.spaceId ? [] : others,
            blocked: channel.kind === "dm" && others.some((other) => shut.has(other.id))
        };
    });
}

/** A stored channel level, or `inherit` for anything the column holds that this
 *  version does not know - including the row not existing at all. */
function channelNotifyOf(stored: string | null | undefined): core.ChatChannelNotifyLevel {
    return core.isChatNotifyLevel(stored) ? stored : core.CHAT_NOTIFY_INHERIT;
}

/** The spaces this actor administers, by either of the two ways of doing so.
 *  The same rule `channelAccess` applies one channel at a time, asked once for
 *  a whole rail. */
async function administeredSpaceIds(actor: ChatActor): Promise<Set<string>> {
    const [owned, admin] = await Promise.all([
        prisma.chatSpace.findMany({ where: { ownerId: actor.id }, select: { id: true } }),
        prisma.chatSpaceMember.findMany({
            where: { userId: actor.id, role: "admin" },
            select: { spaceId: true }
        })
    ]);
    return new Set([...owned.map((row) => row.id), ...admin.map((row) => row.spaceId)]);
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * The headings in every space this person can reach.
 *
 * Asked once for the whole rail rather than per space: a category is three
 * columns, an instance has tens of them, and one query is one round trip.
 */
export async function listCategories(actor: ChatActor): Promise<ChatCategoryView[]> {
    const spaces = await reachableSpaceIds(actor);
    if (spaces.size === 0) return [];

    const rows = await prisma.chatCategory.findMany({
        where: { spaceId: { in: [...spaces] } },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: { id: true, spaceId: true, name: true }
    });
    return rows;
}

/** Add a heading. An administrator of the space, like adding a channel: it
 *  changes the shape of the room for everybody in it. */
export async function createCategory(
    actor: ChatActor,
    input: core.ChatCategoryCreateInput
): Promise<string> {
    await requireSpace(actor, input.spaceId, "admin");
    const category = await prisma.chatCategory.create({
        data: { spaceId: input.spaceId, name: input.name },
        select: { id: true }
    });
    publishChatChange({ channelId: category.id, kind: "channels", actorId: actor.id });
    return category.id;
}

export async function renameCategory(
    actor: ChatActor,
    input: core.ChatCategoryUpdateInput
): Promise<void> {
    const category = await prisma.chatCategory.findUnique({
        where: { id: input.categoryId },
        select: { spaceId: true }
    });
    if (!category) throw new ChatAccessError("That category is gone");
    await requireSpace(actor, category.spaceId, "admin");

    await prisma.chatCategory.update({
        where: { id: input.categoryId },
        data: { name: input.name }
    });
    publishChatChange({ channelId: input.categoryId, kind: "channels", actorId: actor.id });
}

/**
 * Remove a heading.
 *
 * The channels under it stay and move above the first heading - the foreign key
 * is `ON DELETE SET NULL` for exactly this reason. Deleting a grouping must not
 * delete what was grouped, and somebody tidying the rail is not asking to lose
 * four rooms.
 */
export async function deleteCategory(actor: ChatActor, categoryId: string): Promise<void> {
    const category = await prisma.chatCategory.findUnique({
        where: { id: categoryId },
        select: { spaceId: true }
    });
    if (!category) return;
    await requireSpace(actor, category.spaceId, "admin");

    await prisma.chatCategory.delete({ where: { id: categoryId } });
    publishChatChange({ channelId: categoryId, kind: "channels", actorId: actor.id });
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export async function createChannel(
    actor: ChatActor,
    input: core.ChatChannelCreateInput
): Promise<string> {
    await requireSpace(actor, input.spaceId, "admin");

    const clash = await prisma.chatChannel.findFirst({
        where: { spaceId: input.spaceId, name: input.name },
        select: { id: true }
    });
    if (clash) throw new ChatAccessError("A channel with that name is already here");

    // A heading from another space would put the channel somewhere nobody in
    // this one can see it.
    if (input.categoryId) {
        const category = await prisma.chatCategory.findFirst({
            where: { id: input.categoryId, spaceId: input.spaceId },
            select: { id: true }
        });
        if (!category) throw new ChatAccessError("That category is not in this space");
    }

    const channel = await prisma.chatChannel.create({
        data: {
            spaceId: input.spaceId,
            name: input.name,
            topic: input.topic,
            private: input.private,
            kind: input.kind,
            categoryId: input.categoryId,
            createdById: actor.id,
            // A private channel with nobody in it is a channel its creator
            // cannot reopen, so they are put in it on the way through.
            ...(input.private ? { members: { create: { userId: actor.id, role: "admin" } } } : {})
        },
        select: { id: true }
    });
    publishChatChange({ channelId: channel.id, kind: "channels", actorId: actor.id });
    return channel.id;
}

/**
 * Put the channels under one heading in the order somebody dragged them into.
 *
 * The whole list is rewritten rather than the one that moved. It is a handful of
 * rows, it is one transaction, and it means the stored order is exactly the
 * order that was on screen - which a "shift everything after it" would only be
 * as long as nothing else was moving at the same time.
 *
 * Anything not in the list is left where it is. A channel somebody else made
 * while this drag was in flight does not vanish from the rail because it was not
 * in a list drawn before it existed.
 */
export async function reorderChannels(
    actor: ChatActor,
    input: core.ChatChannelReorderInput
): Promise<void> {
    await requireSpace(actor, input.spaceId, "admin");

    if (input.categoryId) {
        const category = await prisma.chatCategory.findFirst({
            where: { id: input.categoryId, spaceId: input.spaceId },
            select: { id: true }
        });
        if (!category) throw new ChatAccessError("That category is not in this space");
    }

    // Every id is checked against the space rather than trusted from the client:
    // an unchecked id here would move a channel out of a space this actor
    // administers into one they do not, or the other way about.
    const mine = await prisma.chatChannel.findMany({
        where: { id: { in: input.channelIds }, spaceId: input.spaceId },
        select: { id: true }
    });
    const allowed = new Set(mine.map((row) => row.id));

    await prisma.$transaction(
        input.channelIds
            .filter((channelId) => allowed.has(channelId))
            .map((channelId, index) =>
                prisma.chatChannel.update({
                    where: { id: channelId },
                    data: { categoryId: input.categoryId, order: index * core.CHAT_ORDER_STEP }
                })
            )
    );
    publishChatChange({ channelId: input.channelIds[0] ?? "", kind: "channels", actorId: "" });
}

/** The same, for the headings themselves. */
export async function reorderCategories(
    actor: ChatActor,
    input: core.ChatCategoryReorderInput
): Promise<void> {
    await requireSpace(actor, input.spaceId, "admin");

    const mine = await prisma.chatCategory.findMany({
        where: { id: { in: input.categoryIds }, spaceId: input.spaceId },
        select: { id: true }
    });
    const allowed = new Set(mine.map((row) => row.id));

    await prisma.$transaction(
        input.categoryIds
            .filter((categoryId) => allowed.has(categoryId))
            .map((categoryId, index) =>
                prisma.chatCategory.update({
                    where: { id: categoryId },
                    data: { order: index * core.CHAT_ORDER_STEP }
                })
            )
    );
    publishChatChange({ channelId: "", kind: "channels", actorId: "" });
}

export async function updateChannel(
    actor: ChatActor,
    input: core.ChatChannelUpdateInput
): Promise<void> {
    const access = await requireChannel(actor, input.channelId);
    if (!access.mayAdminister) throw new ChatAccessError("You cannot change that channel");
    if (!access.spaceId) throw new ChatAccessError("A direct message has no name to change");

    await prisma.chatChannel.update({
        where: { id: input.channelId },
        data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.topic !== undefined ? { topic: input.topic } : {}),
            ...(input.archived !== undefined ? { archived: input.archived } : {}),
            ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
            ...(input.slowmode !== undefined ? { slowmode: input.slowmode } : {})
        }
    });
    publishChatChange({ channelId: input.channelId, kind: "channels", actorId: actor.id });
}

/**
 * Name a group, or take its name off again.
 *
 * Its own entry point rather than `updateChannel`, because the two are not the
 * same kind of name. A channel's is a slug - lowercased and dashed, so a room
 * capitalized differently is the same room - and a group's is a label somebody
 * wrote: "Weekend plans" is what they meant, not "weekend-plans".
 *
 * The owner does it, and everybody else only if the owner has said so - the same
 * switch the picture answers to, because the name and the picture are the two
 * things a group looks like and splitting them would be two settings for one
 * decision. Emptying the name puts it back to being called after the people in
 * it.
 */
export async function renameGroup(
    actor: ChatActor,
    channelId: string,
    name: string
): Promise<void> {
    const access = await requireChannel(actor, channelId);
    if (access.kind !== "group") throw new ChatAccessError("That conversation has no name to set");
    const group = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: { kind: true, ownerId: true, createdById: true, membersMayEdit: true }
    });
    if (!group || !picturesAllowed({ ...group, mayAdminister: access.mayAdminister }, actor.id)) {
        throw new ChatAccessError("Only the owner of this group can rename it");
    }

    await prisma.chatChannel.update({ where: { id: channelId }, data: { name } });
    publishChatChange({ channelId, kind: "channels", actorId: actor.id });
}

/**
 * What the owner of a group has decided about it.
 *
 * One switch today, and it is the one people ask for first: whether the rest of
 * the group may change its name and its picture. Off to begin with, because a
 * group photo anybody can change is a group photo that changes - and on is a
 * decision somebody made rather than the state everybody starts in.
 */
export async function setGroupOptions(
    actor: ChatActor,
    channelId: string,
    options: { membersMayEdit: boolean }
): Promise<void> {
    await requireGroupOwner(actor, channelId);
    await prisma.chatChannel.update({
        where: { id: channelId },
        data: { membersMayEdit: options.membersMayEdit }
    });
    publishChatChange({ channelId, kind: "channels", actorId: actor.id });
}

/**
 * Hand a group over.
 *
 * To somebody already in it, because handing a group to a stranger is two acts
 * and only one of them was asked for. The old owner stays a member: leaving is a
 * separate decision, and doing it for them would be a surprise.
 */
export async function transferGroup(
    actor: ChatActor,
    channelId: string,
    toUserId: string
): Promise<void> {
    await requireGroupOwner(actor, channelId);
    if (toUserId === actor.id) return;

    const member = await prisma.chatChannelMember.findUnique({
        where: { channelId_userId: { channelId, userId: toUserId } },
        select: { id: true }
    });
    if (!member) throw new ChatAccessError("That person is not in this group");

    await prisma.chatChannel.update({ where: { id: channelId }, data: { ownerId: toUserId } });
    publishChatChange({ channelId, kind: "channels", actorId: actor.id });
}

/** The owner of a group, refused loudly. Not "an administrator": a group has
 *  none, which is why it has an owner at all. */
async function requireGroupOwner(actor: ChatActor, channelId: string): Promise<void> {
    await requireChannel(actor, channelId);
    const group = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: { kind: true, ownerId: true, createdById: true }
    });
    if (!group || group.kind !== "group") throw new ChatAccessError("That is not a group");
    if (groupOwnerId(group) !== actor.id) {
        throw new ChatAccessError("Only the owner of this group can do that");
    }
}

export async function deleteChannel(actor: ChatActor, channelId: string): Promise<void> {
    const access = await requireChannel(actor, channelId);
    if (!access.mayAdminister) throw new ChatAccessError("You cannot delete that channel");
    // Bytes first: the attachment rows cascade with the channel, and they are
    // the only record of where the files were written. Deleted after them, the
    // files would be unreachable and unfindable, and would sit on the NAS for
    // the life of the instance.
    await discardChannelFiles([channelId]);
    await discardAvatars("channel", channelId);
    await prisma.chatChannel.delete({ where: { id: channelId } });
    publishChatChange({ channelId, kind: "channels", actorId: actor.id });
}

export async function addChannelMembers(
    actor: ChatActor,
    channelId: string,
    userIds: readonly string[]
): Promise<void> {
    const access = await requireChannel(actor, channelId);
    const group = access.kind === "group";
    if (!access.mayAdminister && !group) {
        throw new ChatAccessError("You cannot add people to that channel");
    }

    const wanted = [...new Set(userIds)];
    if (wanted.length === 0) return;

    if (group) {
        // Past this it is a channel, and saying so is more useful than growing a
        // list nobody can read the header of.
        const already = await prisma.chatChannelMember.count({ where: { channelId } });
        const newcomers = await prisma.chatChannelMember.count({
            where: { channelId, userId: { in: wanted } }
        });
        if (already + wanted.length - newcomers > core.MAX_GROUP_MEMBERS) {
            throw new ChatAccessError(
                `A group holds ${core.MAX_GROUP_MEMBERS} people. Make a channel instead.`
            );
        }
    }
    // Somebody without the chat has no screen this channel could appear on, so
    // putting them in it would be adding a member who can never hear anybody.
    const reachable = await messageable(wanted);
    const missing = wanted.filter((userId) => !reachable.has(userId));
    if (missing.length > 0) throw new ChatAccessError(NO_CHAT);

    // A block stops a group and leaves a channel alone, which is the difference
    // between the two rooms rather than an inconsistency. A group is a personal
    // room somebody assembles out of people they choose, and putting a blocked
    // account in one is the block being walked around. A channel belongs to a
    // space and its roster is an administrative decision - somebody's own
    // decision about their own attention does not get to keep a colleague out
    // of the room they work in. What the block does there is collapse what they
    // say, which is where it belongs.
    if (group) {
        const blocked = await blockedBetween(actor.id, wanted);
        if (blocked.size > 0) throw new ChatAccessError(NO_REACH);
    }

    const already = new Set(
        (
            await prisma.chatChannelMember.findMany({
                where: { channelId, userId: { in: wanted } },
                select: { userId: true }
            })
        ).map((row) => row.userId)
    );

    await prisma.chatChannelMember.createMany({
        data: wanted.map((userId) => ({ channelId, userId })),
        skipDuplicates: true
    });
    // Said in a group and nowhere else. A channel in a space announces its
    // arrivals where the space does; adding somebody to a room the whole space
    // could already read is a change to their list rather than to the room, and
    // a line about it would be a line about nothing.
    if (group) {
        for (const userId of wanted.filter((id) => !already.has(id))) {
            await postNotice(channelId, "added", { subjectId: userId, byId: actor.id });
        }
    }
    publishChatChange({ channelId, kind: "channels", actorId: actor.id, audience: wanted });
}

/**
 * Leaving, or being removed.
 *
 * A one-to-one conversation cannot be left: it is between the people in it, and
 * one of them walking out would leave the other talking to a room that still
 * says two names. A group can, by whoever is leaving and by nobody else -
 * turning somebody out of a group is a thing groups do not do, and a member with
 * the power to do it would change what a group is.
 *
 * @param quietly - Walk out without the group being told. Theirs to choose, and
 *   only when it is their own seat: see `removeSpaceMember`.
 */
export async function removeChannelMember(
    actor: ChatActor,
    channelId: string,
    userId: string,
    quietly = false
): Promise<void> {
    const access = await requireChannel(actor, channelId);
    const group = access.kind === "group";
    if (!access.spaceId && !group) throw new ChatAccessError("A direct message cannot be left");
    if (group && userId !== actor.id) {
        throw new ChatAccessError("Only the person leaving can leave a group");
    }
    if (userId !== actor.id && !access.mayAdminister) {
        throw new ChatAccessError("You cannot remove people from that channel");
    }
    const removed = await prisma.chatChannelMember.deleteMany({ where: { channelId, userId } });
    if (group) await passOnOwnership(channelId, userId);
    // A group only, because in a group the membership is the room: the people
    // in it are who it is. Leaving a channel is leaving the space around it,
    // and that is announced where the space announces everything else.
    if (group && removed.count > 0 && !quietly) {
        await postNotice(channelId, "left", { subjectId: userId });
    }
    publishChatChange({ channelId, kind: "channels", actorId: actor.id, audience: [userId] });
}

/**
 * The owner walked out.
 *
 * A group with an owner who has left is a group nobody can rename, hand over or
 * settle a setting on - and the person who would notice is whoever is still in
 * it. So it passes to whoever has been in it longest, which is the one rule
 * nobody has to be told and nobody can dispute.
 *
 * The last person out leaves it ownerless, which is correct: there is nobody to
 * own it, and the row goes when the conversation does.
 */
async function passOnOwnership(channelId: string, leftId: string): Promise<void> {
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: { ownerId: true, createdById: true }
    });
    if (!channel || groupOwnerId(channel) !== leftId) return;

    const eldest = await prisma.chatChannelMember.findFirst({
        where: { channelId },
        orderBy: { createdAt: "asc" },
        select: { userId: true }
    });
    await prisma.chatChannel.update({
        where: { id: channelId },
        data: { ownerId: eldest?.userId ?? null }
    });
}

/**
 * Go quiet, for a while or until told otherwise.
 *
 * @param minutes - How long, `MUTE_FOREVER` for no end, or null to unmute.
 *   Validated against the offered set rather than taken as a number: an
 *   arbitrary one is not a thing any screen can say afterwards, and "muted for
 *   527 minutes" is not a state anybody chose.
 */
export async function setMuted(
    actor: ChatActor,
    channelId: string,
    minutes: number | null
): Promise<void> {
    await requireChannel(actor, channelId);
    const parsed = core.muteSchema.safeParse({ channelId, minutes });
    if (!parsed.success) throw new ChatAccessError("That is not a length this can be muted for");

    const muted = parsed.data.minutes !== null;
    const mutedUntil = muted ? core.muteEndsAt(parsed.data.minutes!) : null;
    await prisma.chatChannelMember.upsert({
        where: { channelId_userId: { channelId, userId: actor.id } },
        update: { muted, mutedUntil },
        create: { channelId, userId: actor.id, muted, mutedUntil }
    });
    // The rail draws the bell, and the tab that pressed it is not the only one
    // showing this conversation.
    publishChatChange({ channelId, kind: "channels", actorId: actor.id, audience: [actor.id] });
}

/**
 * How much of one conversation is worth being interrupted for.
 *
 * Not a mute, and the difference is the whole point of it existing. A mute is a
 * silence with an end and takes the unread badge with it, which is the right
 * answer to "leave me alone about this" and the wrong one to "tell me when
 * somebody needs me, and let me find the rest later" - the second is what
 * anybody following a busy channel actually wants, and using a mute for it costs
 * them the marks that are how they find the room again.
 *
 * So the two sit side by side and neither replaces the other: this decides what
 * interrupts, the mute decides whether the conversation makes any sign at all.
 *
 * Upserted like the mute beside it, so somebody reading a channel of an open
 * space they were never added to can still say how loudly it may reach them.
 */
export async function setChannelNotify(
    actor: ChatActor,
    channelId: string,
    level: string
): Promise<void> {
    await requireChannel(actor, channelId);
    const parsed = core.chatChannelNotifySchema.safeParse({ channelId, level });
    if (!parsed.success) throw new ChatAccessError("That is not a notification setting");

    const notifyLevel = parsed.data.level;
    await prisma.chatChannelMember.upsert({
        where: { channelId_userId: { channelId, userId: actor.id } },
        update: { notifyLevel },
        create: { channelId, userId: actor.id, notifyLevel }
    });
    publishChatChange({ channelId, kind: "channels", actorId: actor.id, audience: [actor.id] });
}

/**
 * The same answer for a whole space, which is what every channel in it means
 * until one of them says otherwise.
 *
 * Its own row rather than a column on the membership, because the owner of a
 * space is deliberately not a member of it - a preference kept beside the
 * roster would be one the person who started the space could not set.
 */
export async function setSpaceNotify(
    actor: ChatActor,
    spaceId: string,
    level: string
): Promise<void> {
    await requireSpace(actor, spaceId);
    const parsed = core.chatSpaceNotifySchema.safeParse({ spaceId, level });
    if (!parsed.success) throw new ChatAccessError("That is not a notification setting");

    const notifyLevel = parsed.data.level;
    await prisma.chatSpacePreference.upsert({
        where: { spaceId_userId: { spaceId, userId: actor.id } },
        update: { notifyLevel },
        create: { spaceId, userId: actor.id, notifyLevel }
    });
    // Every conversation in the space follows this unless it was given an answer
    // of its own, so the whole rail is what changed.
    publishChatChange({ kind: "channels", actorId: actor.id, audience: [actor.id] });
}

/**
 * Keep a conversation at the top of your own list, or stop.
 *
 * A membership row, like the mute beside it: it is one person's ordering of
 * their own rail and is invisible to everybody else in the room. The upsert is
 * what lets somebody pin a channel in a space they can reach but have never been
 * added to - reading it is enough to want it near the top.
 */
export async function setPinned(
    actor: ChatActor,
    channelId: string,
    pinned: boolean
): Promise<void> {
    await requireChannel(actor, channelId);
    const pinnedAt = pinned ? new Date() : null;
    await prisma.chatChannelMember.upsert({
        where: { channelId_userId: { channelId, userId: actor.id } },
        update: { pinnedAt },
        create: { channelId, userId: actor.id, pinnedAt }
    });
    // Their other tabs are showing the same rail in the old order.
    publishChatChange({ channelId, kind: "channels", actorId: actor.id, audience: [actor.id] });
}

/**
 * The direct message with these people, opening it if it is the first time.
 *
 * A one-to-one conversation is keyed by the pair itself, so two tabs asking at
 * the same moment end up in the same room rather than in two rooms with half the
 * history each. A group has no such key - three people can genuinely want two
 * different group conversations - so asking twice makes two.
 */
export async function openDirect(
    actor: ChatActor,
    userIds: readonly string[],
    /** What to call it, for a group whose starter typed something. A one-to-one
     *  conversation ignores it: it is named after the person in it. */
    name = ""
): Promise<string> {
    const others = [...new Set(userIds)].filter((id) => id !== actor.id);
    if (others.length === 0) throw new ChatAccessError("Pick somebody to message");

    const present = await prisma.user.findMany({
        where: { id: { in: others } },
        select: { id: true, name: true }
    });
    if (present.length !== others.length)
        throw new ChatAccessError("Somebody there no longer has an account");

    // The same rule the picker applies, applied again here: a picker is a
    // convenience and this is the check.
    const reachable = await messageable(others);
    if (reachable.size !== others.length) throw new ChatAccessError(NO_CHAT);

    // A block, in either direction, and the same sentence for both. Which of
    // the two set it is not something this answer may give away: a message
    // reading "they have blocked you" is the block announcing itself, and a
    // different one for each case is the same thing said more slowly.
    const blocked = await blockedBetween(actor.id, others);
    if (blocked.size > 0) throw new ChatAccessError(NO_REACH);

    // Two people is a conversation and three is a group, which is a thing an
    // instance may withhold. Checked here rather than at the action, because a
    // group is also made on the way out of a call taking a third person - and a
    // rule with two implementations is a rule with one hole in it.
    if (others.length > 1 && !(await can(actor.id, "chat.groups"))) {
        throw new ChatAccessError("You are not allowed to start group conversations");
    }

    const everyone = [actor.id, ...others];
    if (others.length === 1) {
        const key = [...everyone].sort().join(":");
        const existing = await prisma.chatChannel.findUnique({
            where: { dmKey: key },
            select: { id: true }
        });
        if (existing) return existing.id;

        try {
            const channel = await prisma.chatChannel.create({
                data: {
                    kind: "dm",
                    name: "",
                    private: true,
                    dmKey: key,
                    createdById: actor.id,
                    members: { createMany: { data: everyone.map((userId) => ({ userId })) } }
                },
                select: { id: true }
            });
            publishChatChange({
                channelId: channel.id,
                kind: "channels",
                actorId: actor.id,
                audience: everyone
            });
            return channel.id;
        } catch (caught) {
            // The other tab won the race. The unique key is what makes that
            // recoverable rather than a second conversation.
            if (!isUniqueViolation(caught)) throw caught;
            const raced = await prisma.chatChannel.findUnique({
                where: { dmKey: key },
                select: { id: true }
            });
            if (!raced) throw caught;
            return raced.id;
        }
    }

    const channel = await prisma.chatChannel.create({
        data: {
            kind: "group",
            name: name.trim().slice(0, core.MAX_CHAT_CHANNEL_NAME),
            private: true,
            createdById: actor.id,
            // Whoever starts a group runs it. Left unset, a group had no owner at
            // all: its creator was told they were not the owner when they tried to
            // name it, no crown showed against anybody, and nobody could hand it
            // over - it could only be abandoned.
            ownerId: actor.id,
            members: { createMany: { data: everyone.map((userId) => ({ userId })) } }
        },
        select: { id: true }
    });
    publishChatChange({
        channelId: channel.id,
        kind: "channels",
        actorId: actor.id,
        audience: everyone
    });
    return channel.id;
}

export async function listChannelMembers(
    actor: ChatActor,
    channelId: string
): Promise<ChatMemberView[]> {
    const access = await requireChannel(actor, channelId);
    if (!access.spaceId || (await isPrivate(channelId))) {
        const [members, channel] = await Promise.all([
            prisma.chatChannelMember.findMany({
                where: { channelId },
                orderBy: { createdAt: "asc" },
                select: { userId: true, role: true, user: { select: { name: true } } }
            }),
            prisma.chatChannel.findUnique({
                where: { id: channelId },
                select: { ownerId: true, createdById: true }
            })
        ]);
        // Worked out rather than stored. A member row is a member or an admin -
        // owning the group is a fact about the group, not about the row - and
        // reading it off the channel is also what puts a crown against the owner
        // of a group made before the column was being filled in.
        const owner = channel ? groupOwnerId(channel) : null;
        return members.map((row) => ({
            userId: row.userId,
            name: row.user.name,
            role: row.userId === owner ? "owner" : row.role
        }));
    }
    // An open channel in a space is everybody in the space, and saying so is
    // more truthful than listing the handful who happen to have a row.
    return listSpaceMembers(actor, access.spaceId);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function isPrivate(channelId: string): Promise<boolean> {
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: { private: true }
    });
    return channel?.private ?? false;
}

/**
 * How much is waiting for one person across the whole of Chat.
 *
 * For the badge on the tab icon and on the Chat entry in the rail. Somebody
 * using the rest of Polaris never opens Chat, and until this existed nothing
 * anywhere told them a message had arrived - the count lived inside the app
 * that already had their attention.
 *
 * Counts only conversations they are a MEMBER of, which is narrower than the
 * rail: a public channel in a space they can reach but never joined has no
 * membership row, so every message in it would read as unread and the tab icon
 * would carry a number nobody can ever take down. Muted and archived ones are
 * left out too - a mute is somebody asking not to be told, and a badge is being
 * told.
 */
export interface ChatUnread {
    /** Messages waiting, for the number on the badge. */
    readonly messages: number;
    /** How many conversations they are in, for a screen that would rather say
     *  "two conversations" than "seventeen messages". */
    readonly conversations: number;
}

export async function unreadTotal(actor: ChatActor): Promise<ChatUnread> {
    const memberships = await prisma.chatChannelMember.findMany({
        where: { userId: actor.id },
        select: { channelId: true, lastReadAt: true, muted: true, mutedUntil: true }
    });
    // Worked out rather than read, for the reason the rail works it out: a mute
    // with an end that has passed is not a mute, and nothing runs to clear it.
    const heard = memberships.filter((row) => !core.muteInForce(row));
    if (heard.length === 0) return { messages: 0, conversations: 0 };

    const live = await prisma.chatChannel.findMany({
        where: { id: { in: heard.map((row) => row.channelId) }, archived: false },
        select: { id: true }
    });
    if (live.length === 0) return { messages: 0, conversations: 0 };

    const counts = await unreadCounts(
        actor,
        live,
        new Map(heard.map((row) => [row.channelId, row]))
    );
    let messages = 0;
    let conversations = 0;
    for (const count of counts.values()) {
        if (count <= 0) continue;
        messages += count;
        conversations += 1;
    }
    return { messages, conversations };
}

/**
 * How much each channel has moved since this reader last looked.
 *
 * Counted from the read mark rather than stored as a number, because a stored
 * counter has to be decremented by every path that could have been read and one
 * of them always forgets. Own messages are excluded: sending one is having read
 * it, and a badge that counted them would never reach zero.
 *
 * One query per channel the reader has a mark in, because each has its own
 * threshold and no single grouped query can carry a different one per group.
 * They run together, and the number of channels one person is in is tens rather
 * than thousands - if that ever stops being true, the fix is a stored counter
 * with one writer, not a cleverer query.
 */
async function unreadCounts(
    actor: ChatActor,
    channels: readonly { id: string }[],
    mine: ReadonlyMap<string, { lastReadAt: Date | null }>
): Promise<Map<string, number>> {
    const counted = new Map<string, number>();
    // Read once and applied to both counts below. A blocked account writing into
    // a room this reader is in must not light their badge: the whole of blocking
    // somebody is not being made to look, and a number that says three messages
    // are waiting is Polaris asking them to look.
    const ignored = [actor.id, ...(await blockedIds(actor.id))];
    const grouped = await prisma.chatMessage.groupBy({
        by: ["channelId"],
        where: {
            channelId: { in: channels.map((channel) => channel.id) },
            deletedAt: null,
            authorId: { notIn: ignored },
            // Somebody joining is not somebody talking. A room that lit up
            // because a person walked into it is a badge that gets ignored,
            // which costs the messages that really are waiting.
            kind: { not: "system" },
            // A thread reply is unread inside the thread, not in the channel:
            // counting both would double every conversation that has one.
            parentId: null
        },
        _count: { _all: true }
    });
    // Only channels with something in them come back from the group-by, so the
    // ones with nothing are already zero.
    const totals = new Map(grouped.map((row) => [row.channelId, row._count._all]));

    const seen = channels.filter((channel) => mine.get(channel.id)?.lastReadAt);
    const since = await Promise.all(
        seen.map(async (channel) => {
            const mark = mine.get(channel.id)!.lastReadAt!;
            const count = await prisma.chatMessage.count({
                where: {
                    channelId: channel.id,
                    deletedAt: null,
                    parentId: null,
                    authorId: { notIn: ignored },
                    kind: { not: "system" },
                    createdAt: { gt: mark }
                }
            });
            return [channel.id, count] as const;
        })
    );
    const marked = new Map(since);

    for (const channel of channels) {
        const count = marked.get(channel.id) ?? totals.get(channel.id) ?? 0;
        counted.set(channel.id, Math.min(count, UNREAD_CAP));
    }
    return counted;
}

/** Everybody this account has blocked, as a plain list of ids. Its own helper
 *  because the counts above need it as an array to sit inside a `notIn`, and a
 *  set would only be turned back into one. */
async function blockedIds(userId: string): Promise<string[]> {
    const rows = await prisma.userBlock.findMany({
        where: { blockerId: userId },
        select: { blockedId: true }
    });
    return rows.map((row) => row.blockedId);
}

/** What a direct message is called: the people in it. Empty when the only other
 *  person deleted their account, which leaves a real conversation with a real
 *  history and nobody at the other end - so it says that rather than nothing. */
function directName(others: readonly { name: string }[]): string {
    if (others.length === 0) return "Just you";
    return others.map((other) => other.name).join(", ");
}

function isUniqueViolation(caught: unknown): boolean {
    return (
        typeof caught === "object" &&
        caught !== null &&
        (caught as Prisma.PrismaClientKnownRequestError).code === "P2002"
    );
}

/** Re-exported so callers need one import for the guard and the work. */
export { ChatAccessError, spaceAccess, channelAccess, type ChatActor };
