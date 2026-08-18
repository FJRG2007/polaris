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
import { ChatAccessError, type ChatActor } from "./access";

/** One invitation, as the panel that made it draws it. */
export interface ChatInviteView {
    readonly id: string;
    readonly code: string;
    readonly expiresAt: string | null;
    readonly maxUses: number | null;
    readonly uses: number;
    readonly usable: boolean;
    readonly createdAt: string;
}

/** What somebody following a link is shown before they decide. */
export interface ChatInviteOffer {
    readonly code: string;
    readonly spaceId: string;
    readonly spaceName: string;
    readonly spaceDescription: string;
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
    if (!space || space.archived) throw new ChatAccessError("That space is not open");

    const membership = await prisma.chatSpaceMember.findUnique({
        where: { spaceId_userId: { spaceId: input.spaceId, userId: actor.id } },
        select: { role: true }
    });
    if (!membership) throw new ChatAccessError("You are not in that space");
    // A private space is one whose roster was chosen. A member who could hand
    // out a link would be choosing it instead of the administrator.
    if (space.visibility === "private" && membership.role !== "admin") {
        throw new ChatAccessError("Only an administrator of this space can invite people to it");
    }

    const invite = await prisma.chatSpaceInvite.create({
        data: {
            spaceId: input.spaceId,
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
 *  administrator sees the lot; anybody else sees their own. */
export async function listInvites(
    actor: ChatActor,
    spaceId: string
): Promise<readonly ChatInviteView[]> {
    const membership = await prisma.chatSpaceMember.findUnique({
        where: { spaceId_userId: { spaceId, userId: actor.id } },
        select: { role: true }
    });
    if (!membership) throw new ChatAccessError("You are not in that space");

    const rows = await prisma.chatSpaceInvite.findMany({
        where: {
            spaceId,
            revokedAt: null,
            ...(membership.role === "admin" ? {} : { createdById: actor.id })
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
    if (!invite) throw new ChatAccessError("That invitation is gone");

    if (invite.createdById !== actor.id) {
        const membership = await prisma.chatSpaceMember.findUnique({
            where: { spaceId_userId: { spaceId: invite.spaceId, userId: actor.id } },
            select: { role: true }
        });
        if (membership?.role !== "admin") {
            throw new ChatAccessError("That invitation is not yours to withdraw");
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
            space: { select: { id: true, name: true, description: true, archived: true } }
        }
    });
    if (!invite) return null;

    const member = await prisma.chatSpaceMember.findUnique({
        where: { spaceId_userId: { spaceId: invite.space.id, userId: actor.id } },
        select: { id: true }
    });

    return {
        code: invite.code,
        spaceId: invite.space.id,
        spaceName: invite.space.name,
        spaceDescription: invite.space.description,
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
 * @returns The space that was joined.
 */
export async function acceptInvite(actor: ChatActor, code: string): Promise<{ spaceId: string }> {
    const invite = await prisma.chatSpaceInvite.findUnique({
        where: { code },
        select: {
            id: true,
            spaceId: true,
            expiresAt: true,
            maxUses: true,
            uses: true,
            revokedAt: true,
            space: { select: { archived: true } }
        }
    });
    if (!invite || invite.space.archived) throw new ChatAccessError("That invitation is gone");
    if (!core.inviteUsable(invite)) throw new ChatAccessError("That invitation is no longer good");

    const already = await prisma.chatSpaceMember.findUnique({
        where: { spaceId_userId: { spaceId: invite.spaceId, userId: actor.id } },
        select: { id: true }
    });
    // Already in it: the link takes them there, and no use is spent. Somebody
    // opening their own invite twice must not burn one of its uses.
    if (already) return { spaceId: invite.spaceId };

    // A link is exactly how somebody who has been banned gets back in, and it is
    // the door a ban exists to stand at. Refused before a use is spent: an
    // invitation should not be consumed by somebody who was never going to be
    // let through it.
    const barred = await prisma.chatSpaceBan.findUnique({
        where: { spaceId_userId: { spaceId: invite.spaceId, userId: actor.id } },
        select: { id: true }
    });
    if (barred) throw new ChatAccessError("You cannot join that space");

    const claimed = await prisma.chatSpaceInvite.updateMany({
        where: {
            id: invite.id,
            revokedAt: null,
            ...(invite.maxUses === null ? {} : { uses: { lt: invite.maxUses } })
        },
        data: { uses: { increment: 1 } }
    });
    if (claimed.count === 0) throw new ChatAccessError("That invitation is no longer good");

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
    return { spaceId: invite.spaceId };
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
    createdAt: true
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
}): ChatInviteView {
    return {
        id: row.id,
        code: row.code,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        maxUses: row.maxUses,
        uses: row.uses,
        usable: core.inviteUsable(row),
        createdAt: row.createdAt.toISOString()
    };
}
