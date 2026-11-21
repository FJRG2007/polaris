/**
 * Invitations to a group conversation (ledger row 16).
 *
 * When somebody's "who can add me to groups" refuses the person adding them,
 * they are asked instead of added: a row here, a quiet notification, and a list
 * at /chat/invites where they accept or decline. Accepting re-checks everything
 * that could have changed since - the group still exists and has room, whoever
 * asked is still in it, and neither has blocked the other - so an old invitation
 * is never a way into a room the rules would now refuse.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { chatWordsFor } from "./text";
import { postNotice } from "./notices";
import { publishChatChange } from "./live";
import { blockedBetween } from "@/lib/blocks";
import { notify } from "@/lib/notifications/dispatch";
import { ChatAccessError, type ChatActor } from "./access";

/** The most invitations listed at once; older pending ones wait their turn. */
export const MOST_GROUP_INVITES_LISTED = 50;

/** How long a declined invitation keeps the same group from asking again. */
export const DECLINE_HOLDS_MS = 30 * 24 * 60 * 60 * 1000;

/** One pending invitation, as the invitee's list draws it. */
export interface GroupInviteView {
    readonly id: string;
    readonly channelId: string;
    readonly groupName: string;
    readonly inviterName: string;
    readonly createdAt: string;
}

/**
 * Ask these people to join the group instead of adding them.
 *
 * One row per person per group: asking again refreshes it and puts it back to
 * pending rather than adding a second. The notification is skipped when a
 * pending invitation already existed, so repeating the add cannot ring anybody.
 */
export async function inviteToGroup(
    actor: ChatActor,
    channelId: string,
    inviteeIds: readonly string[]
): Promise<void> {
    const asked = [...new Set(inviteeIds)].filter((id) => id !== actor.id);
    if (asked.length === 0) return;
    const rows = await prisma.chatGroupInvite.findMany({
        where: { channelId, inviteeId: { in: asked } },
        select: { inviteeId: true, acceptedAt: true, declinedAt: true }
    });
    const pending = new Set(
        rows.filter((row) => !row.acceptedAt && !row.declinedAt).map((row) => row.inviteeId)
    );
    // A recent "no" stands: asking again inside the window changes nothing and
    // notifies nobody, so declining is not the start of being asked daily.
    const since = Date.now() - DECLINE_HOLDS_MS;
    const declined = new Set(
        rows
            .filter((row) => row.declinedAt && row.declinedAt.getTime() > since)
            .map((row) => row.inviteeId)
    );
    const wanted = asked.filter((id) => !declined.has(id));
    if (wanted.length === 0) return;
    await prisma.$transaction(
        wanted.map((inviteeId) =>
            prisma.chatGroupInvite.upsert({
                where: { channelId_inviteeId: { channelId, inviteeId } },
                create: { channelId, inviterId: actor.id, inviteeId },
                update: {
                    inviterId: actor.id,
                    createdAt: new Date(),
                    acceptedAt: null,
                    declinedAt: null
                }
            })
        )
    );
    const fresh = wanted.filter((id) => !pending.has(id));
    if (fresh.length === 0) return;
    const [inviter, group] = await Promise.all([
        prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } }),
        prisma.chatChannel.findUnique({ where: { id: channelId }, select: { name: true } })
    ]);
    await Promise.all(
        fresh.map(async (userId) => {
            const words = await chatWordsFor(userId);
            return notify({
                userId,
                event: "chat.groupInvite",
                title: words("groupInvites.notification", {
                    name: inviter?.name || words("notices.somebody")
                }),
                body: group?.name || null,
                href: "/chat/invites"
            }).catch(() => undefined);
        })
    );
}

/** The invitations waiting on this account, newest first. */
export async function pendingGroupInvites(actor: ChatActor): Promise<GroupInviteView[]> {
    const rows = await prisma.chatGroupInvite.findMany({
        where: { inviteeId: actor.id, acceptedAt: null, declinedAt: null },
        orderBy: { createdAt: "desc" },
        take: MOST_GROUP_INVITES_LISTED,
        select: {
            id: true,
            channelId: true,
            createdAt: true,
            channel: { select: { name: true } },
            inviter: { select: { name: true, username: true } }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        channelId: row.channelId,
        groupName: row.channel.name,
        inviterName: row.inviter.name || (row.inviter.username ? `@${row.inviter.username}` : ""),
        createdAt: row.createdAt.toISOString()
    }));
}

/** The invitation, when it is this account's and still pending. */
async function ownPending(actor: ChatActor, inviteId: string) {
    const invite = await prisma.chatGroupInvite.findUnique({
        where: { id: inviteId },
        select: {
            id: true,
            channelId: true,
            inviterId: true,
            inviteeId: true,
            acceptedAt: true,
            declinedAt: true
        }
    });
    // Somebody else's invitation reads exactly like one that does not exist.
    if (!invite || invite.inviteeId !== actor.id || invite.acceptedAt || invite.declinedAt) {
        throw new ChatAccessError({ key: "errors.groupInviteGone" });
    }
    return invite;
}

/**
 * Accept: join the group, if it would still take this person.
 *
 * Answers with the conversation to open.
 */
export async function acceptGroupInvite(actor: ChatActor, inviteId: string): Promise<string> {
    const invite = await ownPending(actor, inviteId);
    const [group, inviterIn, blocked, members] = await Promise.all([
        prisma.chatChannel.findUnique({
            where: { id: invite.channelId },
            select: { kind: true, archived: true }
        }),
        prisma.chatChannelMember.findUnique({
            where: {
                channelId_userId: { channelId: invite.channelId, userId: invite.inviterId }
            },
            select: { userId: true }
        }),
        blockedBetween(actor.id, [invite.inviterId]),
        prisma.chatChannelMember.count({ where: { channelId: invite.channelId } })
    ]);
    if (!group || group.kind !== "group" || group.archived || !inviterIn || blocked.size > 0) {
        await prisma.chatGroupInvite.update({
            where: { id: invite.id },
            data: { declinedAt: new Date() }
        });
        throw new ChatAccessError({ key: "errors.groupInviteGone" });
    }
    if (members >= core.MAX_GROUP_MEMBERS) {
        throw new ChatAccessError({
            key: "errors.groupFull",
            params: { count: core.MAX_GROUP_MEMBERS }
        });
    }
    await prisma.$transaction([
        prisma.chatChannelMember.createMany({
            data: [{ channelId: invite.channelId, userId: actor.id }],
            skipDuplicates: true
        }),
        prisma.chatGroupInvite.update({
            where: { id: invite.id },
            data: { acceptedAt: new Date() }
        })
    ]);
    await postNotice(invite.channelId, "joined", { subjectId: actor.id });
    publishChatChange({
        channelId: invite.channelId,
        kind: "channels",
        actorId: actor.id,
        audience: [actor.id]
    });
    return invite.channelId;
}

/** Decline: the row stays as history, so it is not asked again as new. */
export async function declineGroupInvite(actor: ChatActor, inviteId: string): Promise<void> {
    const invite = await ownPending(actor, inviteId);
    await prisma.chatGroupInvite.update({
        where: { id: invite.id },
        data: { declinedAt: new Date() }
    });
}
