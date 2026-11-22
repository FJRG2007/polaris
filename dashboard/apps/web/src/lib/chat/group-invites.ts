/**
 * Invitations to a group conversation (ledger row 16).
 *
 * When somebody's "who can add me to groups" refuses the person adding them,
 * they are asked instead of added: a row here, a card with Join and Decline in
 * the direct message from whoever asked (the way a Discord server invite
 * arrives), and a quiet notification that opens it. Accepting re-checks
 * everything that could have changed since - the group still exists and has
 * room, whoever asked is still in it, and neither has blocked the other - so an
 * old invitation is never a way into a room the rules would now refuse.
 *
 * /chat/invites stays as the list behind the card, and is where the
 * notification leads when no card could be posted (a block, a restricted
 * sender): no pending invitation is ever left without a way to answer it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { chatWordsFor } from "./text";
import { postNotice } from "./notices";
import { publishChatChange } from "./live";
import { blockedBetween } from "@/lib/blocks";
import { appBaseUrl } from "@/lib/domain-service";
import { notify } from "@/lib/notifications/dispatch";
import { ChatAccessError, type ChatActor } from "./access";

/** The most invitations listed at once; older pending ones wait their turn. */
export const MOST_GROUP_INVITES_LISTED = 50;

/** The list every invitation can be answered from, card or not. */
const INVITES_PAGE = "/chat/invites";

/** The most older invitations given their card in one pass. */
const MOST_CARDS_AT_ONCE = 10;

interface InviteParties {
    readonly id: string;
    readonly inviterId: string;
    readonly inviteeId: string;
}

/**
 * Post the card for one invitation into the direct message between whoever
 * asked and whoever is asked. Sent as the inviter, through the same
 * `openDirect` and `send` every message of theirs takes, so no privacy rule is
 * stepped around: a block refuses it, and somebody whose "who can message me"
 * leaves the inviter out gets it as a message request.
 *
 * Claimed first (`cardPostedAt`), so it is posted once however many callers
 * race. A refusal keeps the claim: the invitation is answered from
 * /chat/invites instead, and asking every time would only be refused again.
 *
 * Answers with where the notification about it should lead.
 */
async function postInviteCard(invite: InviteParties): Promise<string> {
    const claimed = await prisma.chatGroupInvite.updateMany({
        where: { id: invite.id, cardPostedAt: null, acceptedAt: null, declinedAt: null },
        data: { cardPostedAt: new Date() }
    });
    if (claimed.count === 0) return INVITES_PAGE;
    try {
        // Loaded here: the conversation service adds people through this file.
        const [{ openDirect }, messages] = await Promise.all([
            import("./chat-service"),
            import("./messages")
        ]);
        const inviter = { id: invite.inviterId };
        const channelId = await openDirect(inviter, [invite.inviteeId]);
        // Built on the address Polaris hands out, as a space invite link is.
        const base = (await appBaseUrl()).replace(/\/+$/, "");
        await messages.send(
            inviter,
            { channelId, body: `${base}${core.groupInvitePath(invite.id)}`, replyToId: null },
            [],
            null
        );
        const member = await prisma.chatChannelMember.findUnique({
            where: { channelId_userId: { channelId, userId: invite.inviteeId } },
            select: { requestedAt: true }
        });
        // Held as a request: the conversation is off their list until accepted.
        return member?.requestedAt ? "/chat/requests" : `/chat/c/${channelId}`;
    } catch (caught) {
        if (!(caught instanceof ChatAccessError)) {
            console.error("[chat] could not post a group invitation card", caught);
        }
        return INVITES_PAGE;
    }
}

/**
 * Give the invitations waiting on this account that have no card yet - the
 * ones made before invitations arrived as cards - theirs, once. Asked when
 * Chat opens; their original notification already leads to /chat/invites, so
 * nothing new rings for them.
 */
export async function postWaitingInviteCards(actor: ChatActor): Promise<void> {
    const waiting = await prisma.chatGroupInvite.findMany({
        where: { inviteeId: actor.id, acceptedAt: null, declinedAt: null, cardPostedAt: null },
        orderBy: { createdAt: "asc" },
        take: MOST_CARDS_AT_ONCE,
        select: { id: true, inviterId: true, inviteeId: true }
    });
    // One after another, so they land in the order they were asked.
    for (const invite of waiting) await postInviteCard(invite);
}

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
    const saved = await prisma.$transaction(
        wanted.map((inviteeId) =>
            prisma.chatGroupInvite.upsert({
                where: { channelId_inviteeId: { channelId, inviteeId } },
                create: { channelId, inviterId: actor.id, inviteeId },
                update: {
                    inviterId: actor.id,
                    createdAt: new Date(),
                    acceptedAt: null,
                    declinedAt: null,
                    // Asked anew: a new card. One still pending keeps the card
                    // it has, which answers the same row.
                    ...(pending.has(inviteeId) ? {} : { cardPostedAt: null })
                },
                select: { id: true, inviterId: true, inviteeId: true }
            })
        )
    );
    const fresh = saved.filter((row) => !pending.has(row.inviteeId));
    if (fresh.length === 0) return;
    const [inviter, group] = await Promise.all([
        prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } }),
        prisma.chatChannel.findUnique({ where: { id: channelId }, select: { name: true } })
    ]);
    await Promise.all(
        fresh.map(async (invite) => {
            const href = await postInviteCard(invite);
            const words = await chatWordsFor(invite.inviteeId);
            return notify({
                userId: invite.inviteeId,
                event: "chat.groupInvite",
                title: words("groupInvites.notification", {
                    name: inviter?.name || words("notices.somebody")
                }),
                body: group?.name || null,
                href
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
