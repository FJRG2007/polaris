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

/** A conversation in the rail: a channel, or a direct message. */
export interface ChatChannelView {
    readonly id: string;
    readonly spaceId: string | null;
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
    /** Whether this reader administers the conversation, which is what decides
     *  whether the screen offers them anything only a moderator may do. Always
     *  false in a direct message, where everybody in one is equal in it. */
    readonly mayAdminister: boolean;
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
            select: { channelId: true, lastReadAt: true, muted: true, role: true }
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
            kind: true,
            name: true,
            topic: true,
            private: true,
            archived: true,
            lastMessageAt: true,
            members: { select: { userId: true, user: { select: { name: true } } } }
        }
    });
    if (channels.length === 0) return [];

    const unread = await unreadCounts(actor, channels, mine);

    return channels.map((channel) => {
        const others = channel.members
            .filter((member) => member.userId !== actor.id)
            .map((member) => ({ id: member.userId, name: member.user.name }));
        return {
            id: channel.id,
            spaceId: channel.spaceId,
            kind: channel.kind as core.ChatChannelKind,
            name: channel.spaceId ? channel.name : directName(others),
            topic: channel.topic,
            private: channel.private,
            archived: channel.archived,
            lastMessageAt: channel.lastMessageAt?.toISOString() ?? null,
            unread: unread.get(channel.id) ?? 0,
            muted: mine.get(channel.id)?.muted ?? false,
            mayAdminister: Boolean(
                channel.spaceId &&
                    (administered.has(channel.spaceId) || mine.get(channel.id)?.role === "admin")
            ),
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

    const channel = await prisma.chatChannel.create({
        data: {
            spaceId: input.spaceId,
            name: input.name,
            topic: input.topic,
            private: input.private,
            kind: "text",
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
            ...(input.archived !== undefined ? { archived: input.archived } : {})
        }
    });
    publishChatChange({ channelId: input.channelId, kind: "channels", actorId: actor.id });
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
    if (!access.mayAdminister) throw new ChatAccessError("You cannot add people to that channel");

    const wanted = [...new Set(userIds)];
    if (wanted.length === 0) return;
    await prisma.chatChannelMember.createMany({
        data: wanted.map((userId) => ({ channelId, userId })),
        skipDuplicates: true
    });
    publishChatChange({ channelId, kind: "channels", actorId: actor.id, audience: wanted });
}

/** Leaving, or being removed. A direct message cannot be left: it is between the
 *  people in it, and one of them walking out would leave the other talking to a
 *  room that still says two names. */
export async function removeChannelMember(
    actor: ChatActor,
    channelId: string,
    userId: string
): Promise<void> {
    const access = await requireChannel(actor, channelId);
    if (!access.spaceId) throw new ChatAccessError("A direct message cannot be left");
    if (userId !== actor.id && !access.mayAdminister) {
        throw new ChatAccessError("You cannot remove people from that channel");
    }
    await prisma.chatChannelMember.deleteMany({ where: { channelId, userId } });
    publishChatChange({ channelId, kind: "channels", actorId: actor.id, audience: [userId] });
}

export async function setMuted(actor: ChatActor, channelId: string, muted: boolean): Promise<void> {
    await requireChannel(actor, channelId);
    await prisma.chatChannelMember.upsert({
        where: { channelId_userId: { channelId, userId: actor.id } },
        update: { muted },
        create: { channelId, userId: actor.id, muted }
    });
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
