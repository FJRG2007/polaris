/**
 * Invitations into a space.
 *
 * **The code is the whole credential.** Somebody holding one is not proving they
 * were invited; they are proving they have a string that somebody who was
 * invited could have forwarded. Everything here follows from that:
 *
 * - What one grants is one space and nothing else. Not the instance, not the
 *   organization, not the private channels inside the space - joining a space
 *   gets somebody the channels a member sees, which is the same set they would
 *   have got had an administrator added them by hand.
 * - Every bound is checked at the moment a code is presented, never only when it
 *   was made. An invite that has run out of uses or of time is refused on use.
 * - Accepting is one statement that counts the use and takes the seat, so two
 *   people presenting the last use of a one-use invite at the same instant do
 *   not both get in.
 * - An invitation to a private space is an administrator's to make. A private
 *   space is one whose roster is chosen; a member who could hand out a link to
 *   it would be choosing the roster instead.
 *
 * The code is read back by anybody signed in, because they have to be told what
 * they are being asked to join before they decide. What that tells somebody who
 * guessed a code is the name of a space, which is the price of a link that says
 * where it goes.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { randomBytes } from "node:crypto";
import { publishChatChange } from "./live";
import { postSpaceNotice } from "./notices";
import * as messages from "./messages";
import { openDirect } from "./chat-service";
import { friendIds } from "@/lib/friends-service";
import { SHORTEST_SEARCH } from "@/lib/people-search";
import { appBaseUrl } from "@/lib/domain-service";
import { rateLimit } from "@/lib/rate-limit-service";
import {
    ChatAccessError,
    ChatRuleError,
    searchForConversation,
    spaceAccess,
    type ChatActor
} from "./access";

/** One invitation, as the panel that made it draws it. */
export interface ChatInviteView {
    readonly id: string;
    readonly code: string;
    readonly expiresAt: string | null;
    readonly maxUses: number | null;
    readonly uses: number;
    readonly usable: boolean;
    readonly createdAt: string;
    /** The channel it opens on, or null for one onto the space itself. */
    readonly channelId: string | null;
    /** Who made it, for the list an administrator reads. Null once their
     *  account is gone. */
    readonly createdBy: string | null;
}

/** What somebody following a link is shown before they decide. */
export interface ChatInviteOffer {
    readonly code: string;
    readonly spaceId: string;
    readonly spaceName: string;
    readonly spaceDescription: string;
    /** The channel the link opens on, when it names one joining reaches. */
    readonly channelId: string | null;
    readonly channelName: string | null;
    readonly invitedBy: string | null;
    /** Whether it can still be used at all. A refused invite still names the
     *  space, because "this link has expired" is only useful with the thing it
     *  led to beside it. */
    readonly usable: boolean;
    /** True when they are in the space already, so the button says "Open" rather
     *  than offering to add them a second time. */
    readonly alreadyIn: boolean;
}

/**
 * Make an invitation.
 *
 * @param input - Which space, how long for, and how many people. Both bounds are
 *   from the offered sets, since "expires in 527 minutes" is not a thing any
 *   screen could describe afterwards.
 */
export async function createInvite(
    actor: ChatActor,
    input: core.ChatInviteCreateInput
): Promise<ChatInviteView> {
    const space = await prisma.chatSpace.findUnique({
        where: { id: input.spaceId },
        select: { id: true, visibility: true, archived: true }
    });
    if (!space || space.archived) throw new ChatAccessError({ key: "errors.spaceNotOpen" });

    // The owner has no membership row - the space is theirs - so the standing is
    // asked the way every other screen asks it, not off the row alone.
    const standing = await spaceAccess(actor, input.spaceId);
    if (!standing) throw new ChatAccessError({ key: "errors.notInSpace" });
    // A private space is one whose roster was chosen. A member who could hand
    // out a link would be choosing it instead of the administrator.
    if (!core.spaceInviteAllowed(standing, space.visibility)) {
        throw new ChatAccessError({ key: "errors.spaceInviteAdminOnly" });
    }

    // A link that opens on one channel: that channel has to be one joining the
    // space leads to. A private one is not - joining the space does not open
    // it - so a link to it would be a link to a door that stays shut.
    if (input.channelId) {
        const channel = await prisma.chatChannel.findUnique({
            where: { id: input.channelId },
            select: { spaceId: true, private: true, archived: true }
        });
        if (!channel || channel.spaceId !== input.spaceId || channel.private || channel.archived) {
            throw new ChatAccessError({ key: "errors.inviteChannelNotOpen" });
        }
    }

    const invite = await prisma.chatSpaceInvite.create({
        data: {
            spaceId: input.spaceId,
            channelId: input.channelId ?? null,
            code: newCode(),
            createdById: actor.id,
            expiresAt: core.inviteExpiresAt(input.expiresMinutes),
            maxUses: input.maxUses === core.INVITE_UNLIMITED ? null : input.maxUses
        },
        select: SELECT
    });
    return view(invite);
}

/** The invitations somebody made for a space, newest first. Only an
 *  administrator sees the lot; anybody else sees their own. With a channel,
 *  only the links that open on it - what that channel's settings list. */
export async function listInvites(
    actor: ChatActor,
    spaceId: string,
    channelId?: string
): Promise<readonly ChatInviteView[]> {
    const standing = await spaceAccess(actor, spaceId);
    if (!standing) throw new ChatAccessError({ key: "errors.notInSpace" });

    const rows = await prisma.chatSpaceInvite.findMany({
        where: {
            spaceId,
            revokedAt: null,
            ...(channelId ? { channelId } : {}),
            ...(standing === "member" ? { createdById: actor.id } : {})
        },
        orderBy: { createdAt: "desc" },
        take: 25,
        select: SELECT
    });
    return rows.map(view);
}

/** Withdraw one. Whoever made it, or an administrator of the space. */
export async function revokeInvite(actor: ChatActor, inviteId: string): Promise<void> {
    const invite = await prisma.chatSpaceInvite.findUnique({
        where: { id: inviteId },
        select: { id: true, spaceId: true, createdById: true }
    });
    if (!invite) throw new ChatAccessError({ key: "errors.invitationGone" });

    if (invite.createdById !== actor.id) {
        const standing = await spaceAccess(actor, invite.spaceId);
        if (standing !== "owner" && standing !== "admin") {
            throw new ChatAccessError({ key: "errors.invitationNotYours" });
        }
    }

    // Kept rather than deleted, so a link that stops working can say it was
    // withdrawn instead of pretending it never existed.
    await prisma.chatSpaceInvite.update({
        where: { id: inviteId },
        data: { revokedAt: new Date() }
    });
}

/** What a link says it leads to. */
export async function readInvite(actor: ChatActor, code: string): Promise<ChatInviteOffer | null> {
    const invite = await prisma.chatSpaceInvite.findUnique({
        where: { code },
        select: {
            code: true,
            expiresAt: true,
            maxUses: true,
            uses: true,
            revokedAt: true,
            createdBy: { select: { name: true } },
            space: { select: { id: true, name: true, description: true, archived: true } },
            channel: { select: { id: true, name: true, private: true } }
        }
    });
    if (!invite) return null;
    const landing = invite.channel && !invite.channel.private ? invite.channel : null;

    const member = await prisma.chatSpaceMember.findUnique({
        where: { spaceId_userId: { spaceId: invite.space.id, userId: actor.id } },
        select: { id: true }
    });

    return {
        code: invite.code,
        spaceId: invite.space.id,
        spaceName: invite.space.name,
        spaceDescription: invite.space.description,
        channelId: landing?.id ?? null,
        channelName: landing?.name ?? null,
        invitedBy: invite.createdBy?.name ?? null,
        usable: !invite.space.archived && core.inviteUsable(invite),
        alreadyIn: member !== null
    };
}

/**
 * Take the invitation.
 *
 * The use is counted and the seat taken in one statement each, and the count
 * carries its own bound in the `where`: two people presenting the last use of a
 * one-use invite at the same instant means one of them is refused rather than
 * both being let in.
 *
 * @returns The space that was joined, and the channel the link opens on when it
 *   names one that joining the space reaches.
 */
export async function acceptInvite(
    actor: ChatActor,
    code: string
): Promise<{ spaceId: string; channelId: string | null }> {
    const invite = await prisma.chatSpaceInvite.findUnique({
        where: { code },
        select: {
            id: true,
            spaceId: true,
            expiresAt: true,
            maxUses: true,
            uses: true,
            revokedAt: true,
            channelId: true,
            channel: { select: { private: true } },
            space: { select: { archived: true } }
        }
    });
    if (!invite || invite.space.archived)
        throw new ChatAccessError({ key: "errors.invitationGone" });
    // Made private since the link was shared: joining no longer opens it, so the
    // link lands on the space instead of on a room that would refuse them.
    const landing =
        invite.channelId && invite.channel && !invite.channel.private ? invite.channelId : null;
    if (!core.inviteUsable(invite)) throw new ChatAccessError({ key: "errors.invitationExpired" });

    const already = await prisma.chatSpaceMember.findUnique({
        where: { spaceId_userId: { spaceId: invite.spaceId, userId: actor.id } },
        select: { id: true }
    });
    // Already in it: the link takes them there, and no use is spent. Somebody
    // opening their own invite twice must not burn one of its uses.
    if (already) return { spaceId: invite.spaceId, channelId: landing };

    // A link is exactly how somebody who has been banned gets back in, and it is
    // the door a ban exists to stand at. Refused before a use is spent: an
    // invitation should not be consumed by somebody who was never going to be
    // let through it.
    const barred = await prisma.chatSpaceBan.findUnique({
        where: { spaceId_userId: { spaceId: invite.spaceId, userId: actor.id } },
        select: { id: true }
    });
    if (barred) throw new ChatAccessError({ key: "errors.spaceJoinNotAllowed" });

    const claimed = await prisma.chatSpaceInvite.updateMany({
        where: {
            id: invite.id,
            revokedAt: null,
            ...(invite.maxUses === null ? {} : { uses: { lt: invite.maxUses } })
        },
        data: { uses: { increment: 1 } }
    });
    if (claimed.count === 0) throw new ChatAccessError({ key: "errors.invitationExpired" });

    await prisma.chatSpaceMember.create({
        data: { spaceId: invite.spaceId, userId: actor.id, role: "member" }
    });
    // "joined" rather than "added": nobody put them here, they walked in with a
    // link. Who made the link is not part of it - an invitation can pass through
    // several hands before it is used.
    await postSpaceNotice(invite.spaceId, "joined", { subjectId: actor.id });
    // The rail is what changes for them, and nothing else would tell it.
    publishChatChange({
        channelId: "",
        kind: "channels",
        actorId: "",
        audience: [actor.id]
    });
    return { spaceId: invite.spaceId, channelId: landing };
}

// ---------------------------------------------------------------------------
// The invite dialog: one link ready on open, sent to people one at a time
// ---------------------------------------------------------------------------

/** A link is reused while it has at least this long left, so reopening the
 *  dialog does not mint a new code every time - and a link about to run out is
 *  never the one handed to somebody. */
const REUSE_MARGIN_MS = 24 * 60 * 60_000;

/** Sends per person per window. Generous for inviting a room of friends one by
 *  one, and a wall for a script walking a list. */
export const INVITE_SENDS_PER_WINDOW = 30;
export const INVITE_SEND_WINDOW_MS = 60_000;

/**
 * The link the invite dialog opens on.
 *
 * The newest of this person's own links to the same room that is unbounded in
 * uses and has a day or more to run, or a new one with the defaults. Opened
 * from no room in particular, it points at the space's first open room, so a
 * recipient lands somewhere rather than on an empty space.
 */
export async function inviteLink(
    actor: ChatActor,
    input: core.ChatInviteLinkInput
): Promise<ChatInviteView> {
    const channelId = input.channelId ?? (await firstOpenChannel(input.spaceId));
    const reusable = await prisma.chatSpaceInvite.findFirst({
        where: {
            spaceId: input.spaceId,
            channelId,
            createdById: actor.id,
            revokedAt: null,
            maxUses: null,
            OR: [
                { expiresAt: null },
                { expiresAt: { gt: new Date(Date.now() + REUSE_MARGIN_MS) } }
            ]
        },
        orderBy: { createdAt: "desc" },
        select: { ...SELECT, space: { select: { visibility: true, archived: true } } }
    });
    if (reusable && !reusable.space.archived) {
        // Asked again rather than trusted: somebody demoted in a private space
        // since the link was made may no longer hand it out.
        const standing = await spaceAccess(actor, input.spaceId);
        if (!core.spaceInviteAllowed(standing, reusable.space.visibility)) {
            throw new ChatAccessError({ key: "errors.spaceInviteAdminOnly" });
        }
        return view(reusable);
    }
    return createInvite(actor, {
        spaceId: input.spaceId,
        ...(channelId ? { channelId } : {}),
        expiresMinutes: core.INVITE_DEFAULT_MINUTES,
        maxUses: core.INVITE_DEFAULT_USES
    });
}

/** Somebody the invite dialog lists. */
export interface ChatInviteCandidate {
    readonly id: string;
    readonly name: string;
    readonly username: string | null;
    /** In the space already, so there is nothing to send them. */
    readonly member: boolean;
}

/**
 * Who the invite dialog offers.
 *
 * With nothing typed, the inviter's friends. With a search, the same reach the
 * new-conversation picker has (`searchForConversation`): a friend by any part of
 * their name, anybody else by their whole username, and nobody privacy, a block
 * or a missing chat permission keeps out of a direct message.
 */
export async function inviteCandidates(
    actor: ChatActor,
    spaceId: string,
    query: string
): Promise<readonly ChatInviteCandidate[]> {
    if (!(await spaceAccess(actor, spaceId))) {
        throw new ChatAccessError({ key: "errors.notInSpace" });
    }

    // A search needs two characters before it reaches past friends; one typed
    // letter narrows the friends list instead of emptying it.
    const ids =
        query.length >= SHORTEST_SEARCH
            ? (await searchForConversation(actor, query, 25)).people.map((person) => person.id)
            : [...(await friendIds(actor.id))].filter((id) => id !== actor.id);
    if (ids.length === 0) return [];

    const [people, members, space] = await Promise.all([
        prisma.user.findMany({
            where: {
                id: { in: ids },
                ...(query && query.length < SHORTEST_SEARCH
                    ? {
                          OR: [
                              { name: { contains: query, mode: "insensitive" as const } },
                              { username: { startsWith: query, mode: "insensitive" as const } }
                          ]
                      }
                    : {})
            },
            orderBy: { name: "asc" },
            take: 100,
            select: { id: true, name: true, username: true }
        }),
        prisma.chatSpaceMember.findMany({
            where: { spaceId, userId: { in: ids } },
            select: { userId: true }
        }),
        prisma.chatSpace.findUnique({ where: { id: spaceId }, select: { ownerId: true } })
    ]);
    const inside = new Set(members.map((row) => row.userId));
    if (space) inside.add(space.ownerId);
    return people
        .map((person) => ({
            id: person.id,
            name: person.name,
            username: person.username,
            member: inside.has(person.id)
        }))
        .sort((one, other) => Number(one.member) - Number(other.member));
}

/**
 * Send a link to one person, as a message from the inviter in the direct
 * conversation between them - opened through the ordinary path, so every rule
 * that decides whether these two may message applies here too.
 *
 * Idempotent per (invite, person): the pair is claimed in a unique row before
 * anything is posted, so a double click or two tabs post one message. A claim
 * whose message never went out is released, so a retry can send it.
 */
export async function sendInvite(
    actor: ChatActor,
    input: core.ChatInviteSendInput
): Promise<{ channelId: string; already: boolean }> {
    const invite = await prisma.chatSpaceInvite.findUnique({
        where: { code: input.code },
        select: {
            id: true,
            code: true,
            spaceId: true,
            expiresAt: true,
            maxUses: true,
            uses: true,
            revokedAt: true,
            space: { select: { visibility: true, archived: true } }
        }
    });
    if (!invite || invite.space.archived) {
        throw new ChatAccessError({ key: "errors.invitationGone" });
    }
    if (!core.inviteUsable(invite)) throw new ChatAccessError({ key: "errors.invitationExpired" });
    const standing = await spaceAccess(actor, invite.spaceId);
    if (!core.spaceInviteAllowed(standing, invite.space.visibility)) {
        throw new ChatAccessError({ key: "errors.spaceInviteAdminOnly" });
    }
    if (input.userId === actor.id) throw new ChatAccessError({ key: "errors.inviteNotSent" });

    const earlier = await prisma.chatInviteSend.findUnique({
        where: { inviteId_recipientId: { inviteId: invite.id, recipientId: input.userId } },
        select: { channelId: true }
    });
    if (earlier) return { channelId: earlier.channelId ?? "", already: true };

    const allowed = await rateLimit(
        `chat-invite-send:${actor.id}`,
        INVITE_SENDS_PER_WINDOW,
        INVITE_SEND_WINDOW_MS
    );
    if (!allowed.ok) {
        throw new ChatRuleError({
            key: "errors.inviteSendLimit",
            params: { seconds: Math.max(1, Math.ceil(allowed.retryAfterMs / 1000)) }
        });
    }

    let claim: { id: string };
    try {
        claim = await prisma.chatInviteSend.create({
            data: { inviteId: invite.id, recipientId: input.userId },
            select: { id: true }
        });
    } catch (error) {
        // The other click won the claim and is posting the message.
        if ((error as { code?: string }).code === "P2002") return { channelId: "", already: true };
        throw error;
    }

    try {
        const channelId = await openDirect(actor, [input.userId]);
        // Built on the address Polaris hands out, never on the sender's tab:
        // a LAN name resolves on their network alone.
        const base = (await appBaseUrl()).replace(/\/+$/, "");
        await messages.send(
            actor,
            { channelId, body: `${base}/chat/i/${invite.code}`, replyToId: null },
            [],
            null
        );
        await prisma.chatInviteSend.update({ where: { id: claim.id }, data: { channelId } });
        return { channelId, already: false };
    } catch (error) {
        await prisma.chatInviteSend.delete({ where: { id: claim.id } }).catch(() => undefined);
        throw error;
    }
}

async function firstOpenChannel(spaceId: string): Promise<string | null> {
    const channel = await prisma.chatChannel.findFirst({
        where: { spaceId, private: false, archived: false, kind: "text" },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: { id: true }
    });
    return channel?.id ?? null;
}
// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const SELECT = {
    id: true,
    code: true,
    expiresAt: true,
    maxUses: true,
    uses: true,
    revokedAt: true,
    createdAt: true,
    channelId: true,
    createdBy: { select: { name: true } }
} as const;

/** A code from the URL-safe alphabet, so it survives being pasted anywhere. */
function newCode(): string {
    return randomBytes(32).toString("base64url").slice(0, core.CHAT_INVITE_CODE_LENGTH);
}

function view(row: {
    id: string;
    code: string;
    expiresAt: Date | null;
    maxUses: number | null;
    uses: number;
    revokedAt: Date | null;
    createdAt: Date;
    channelId: string | null;
    createdBy: { name: string } | null;
}): ChatInviteView {
    return {
        id: row.id,
        code: row.code,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        maxUses: row.maxUses,
        uses: row.uses,
        usable: core.inviteUsable(row),
        createdAt: row.createdAt.toISOString(),
        channelId: row.channelId,
        createdBy: row.createdBy?.name ?? null
    };
}
