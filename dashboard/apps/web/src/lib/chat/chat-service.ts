/**
 * Spaces, channels and who is in them.
 *
 * Everything here takes an actor and answers through `access.ts` first, without
 * exception: there is no "internal" entry point that skips the check because the
 * caller already knows. Messages live next door in `messages.ts` - the split is
 * where the rail ends and the conversation begins, which is also where the read
 * volume changes by two orders of magnitude.
 */

import * as core from "@polaris/core";
import { publishChatChange } from "./live";
import { prisma, type Prisma } from "@polaris/db";
import {
    ChatAccessError,
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
    /** Whether this reader may put a picture on it - the space's people for a
     *  channel, whoever started it for a group. Only decides what the screen
     *  offers; the route that stores the bytes asks the same question again. */
    readonly mayPicture: boolean;
    /** The other people in a direct message, for the avatars beside it. Empty
     *  for a named channel, where the name is the whole label. */
    readonly others: readonly { id: string; name: string }[];
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

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

/** Every space this person can reach, ordered as the rail shows them. */
export async function listSpaces(actor: ChatActor): Promise<ChatSpaceView[]> {
    const ids = await reachableSpaceIds(actor);
    if (ids.size === 0) return [];

    const [spaces, memberships] = await Promise.all([
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
        })
    ]);

    const roles = new Map(memberships.map((row) => [row.spaceId, row.role]));
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
                  : "member"
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
    const wanted = [...new Set(userIds)].filter((id) => id !== space?.ownerId);
    if (wanted.length === 0) return;

    await prisma.chatSpaceMember.createMany({
        data: wanted.map((userId) => ({ spaceId, userId })),
        skipDuplicates: true
    });
    publishChatChange({
        channelId: spaceId,
        kind: "channels",
        actorId: actor.id,
        audience: wanted
    });
}

export async function removeSpaceMember(
    actor: ChatActor,
    spaceId: string,
    userId: string
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
    publishChatChange({
        channelId: spaceId,
        kind: "channels",
        actorId: actor.id,
        audience: [userId]
    });
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
            createdById: true,
            members: { select: { userId: true, user: { select: { name: true } } } }
        }
    });
    if (channels.length === 0) return [];

    const unread = await unreadCounts(actor, channels, mine);

    return channels.map((channel) => {
        const others = channel.members
            .filter((member) => member.userId !== actor.id)
            .map((member) => ({ id: member.userId, name: member.user.name }));
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
            pinned: membership?.pinnedAt !== null && membership?.pinnedAt !== undefined,
            mayAdminister,
            // Whether the screen offers this reader the picture control. The
            // same predicate the route enforces with, asked here so the rule
            // has one implementation rather than two that drift.
            mayPicture: picturesAllowed({ ...channel, mayAdminister }, actor.id),
            others: channel.spaceId ? [] : others
        };
    });
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

    await prisma.chatCategory.update({ where: { id: input.categoryId }, data: { name: input.name } });
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
            ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {})
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
 * Anybody in the group may do it. A group belongs to everybody in it, and an
 * owner would make it a channel with extra steps. Emptying the name puts it back
 * to being called after the people in it.
 */
export async function renameGroup(
    actor: ChatActor,
    channelId: string,
    name: string
): Promise<void> {
    const access = await requireChannel(actor, channelId);
    if (access.kind !== "group") throw new ChatAccessError("That conversation has no name to set");

    await prisma.chatChannel.update({ where: { id: channelId }, data: { name } });
    publishChatChange({ channelId, kind: "channels", actorId: actor.id });
}

export async function deleteChannel(actor: ChatActor, channelId: string): Promise<void> {
    const access = await requireChannel(actor, channelId);
    if (!access.mayAdminister) throw new ChatAccessError("You cannot delete that channel");
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

    await prisma.chatChannelMember.createMany({
        data: wanted.map((userId) => ({ channelId, userId })),
        skipDuplicates: true
    });
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
 */
export async function removeChannelMember(
    actor: ChatActor,
    channelId: string,
    userId: string
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
    await prisma.chatChannelMember.deleteMany({ where: { channelId, userId } });
    publishChatChange({ channelId, kind: "channels", actorId: actor.id, audience: [userId] });
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
export async function openDirect(actor: ChatActor, userIds: readonly string[]): Promise<string> {
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
            name: "",
            private: true,
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
}

export async function listChannelMembers(
    actor: ChatActor,
    channelId: string
): Promise<ChatMemberView[]> {
    const access = await requireChannel(actor, channelId);
    if (!access.spaceId || (await isPrivate(channelId))) {
        const members = await prisma.chatChannelMember.findMany({
            where: { channelId },
            orderBy: { createdAt: "asc" },
            select: { userId: true, role: true, user: { select: { name: true } } }
        });
        return members.map((row) => ({ userId: row.userId, name: row.user.name, role: row.role }));
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
    const grouped = await prisma.chatMessage.groupBy({
        by: ["channelId"],
        where: {
            channelId: { in: channels.map((channel) => channel.id) },
            deletedAt: null,
            authorId: { not: actor.id },
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
                    authorId: { not: actor.id },
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
