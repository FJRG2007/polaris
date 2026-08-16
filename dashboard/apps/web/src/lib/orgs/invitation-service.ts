/**
 * Asking somebody to join an organization, and their answer.
 *
 * Joining a group is a thing a person does, not a thing that is done to them.
 * Polaris used to write the membership row on the spot: whoever ran the roster
 * typed an address and somebody else's account was on a roster, under a role
 * they never saw, visible to everybody else on it. That is a surprise at best
 * and a disclosure at worst - a roster says who you work with - so it is an
 * invitation now, exactly as it is on GitHub.
 *
 * Everything here is about a row that exists only while nobody has answered.
 * Accepting turns it into a membership and deletes it; declining and revoking
 * delete it. There is no record of a refusal, deliberately: a stored "no" is a
 * thing somebody has to clean up, and it would stand between the same two people
 * the next time one of them asks.
 *
 * Authorization is the caller's - the actions layer clears `people.manage`
 * before anything here runs, and the two functions an invitee calls check that
 * the invitation is theirs, because nobody else can clear that for them.
 */

import { OrgError } from "./errors";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { organizationPolicy } from "./policy";
import { ensureSystemRoles } from "./role-service";
import { contactLines } from "@/lib/privacy-service";
import { notify } from "@/lib/notifications/dispatch";

/**
 * How long an unanswered invitation stands.
 *
 * A week, which is what GitHub settled on and long enough for somebody who is
 * away. Past it the row is ignored on read rather than deleted on a schedule:
 * an expiry that depends on a sweep having run is an expiry that quietly does
 * not happen.
 */
const GOOD_FOR_DAYS = 7;

/** One invitation, as either side's screen draws it. */
export interface OrgInvitationView {
    readonly id: string;
    readonly orgId: string;
    readonly orgName: string;
    readonly orgSlug: string;
    readonly userId: string;
    /** Who was asked, as the roster would name them. */
    readonly name: string;
    /** Their handle, or their address when they show it to whoever is looking. */
    readonly contact: string;
    /** The role's slug, and what this organization calls it. */
    readonly role: string;
    readonly roleName: string;
    readonly invitedBy: string;
    readonly invitedAt: string;
    readonly expiresAt: string;
}

function expiry(): Date {
    return new Date(Date.now() + GOOD_FOR_DAYS * 24 * 60 * 60 * 1000);
}

/** Only rows that have not run out. Every read filters on it, so an invitation
 *  that expired on Sunday cannot be accepted on Monday. */
function live() {
    return { expiresAt: { gt: new Date() } };
}

/**
 * Ask somebody, by the address or handle whoever is doing it has in front of
 * them.
 *
 * Asking again replaces the invitation rather than failing: changing your mind
 * about the role you offered is the same act, and a second row for the same pair
 * is a roster with two answers to one question.
 */
export async function inviteToOrg(
    orgId: string,
    identifier: string,
    role: string,
    invitedById: string
): Promise<void> {
    await ensureSystemRoles(orgId);
    await assertRoleExists(orgId, role);

    const needle = identifier.trim().toLowerCase();
    const user = await prisma.user.findFirst({
        where: { OR: [{ email: needle }, { username: needle }] },
        select: { id: true, bannedAt: true }
    });
    if (!user) throw new OrgError("No account matches that email or username");
    if (user.bannedAt) throw new OrgError("That account is suspended");

    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ownerId: true, name: true, slug: true }
    });
    if (!org) throw new OrgError("That organization no longer exists");
    if (org.ownerId === user.id) throw new OrgError("That person already owns this organization");

    const already = await prisma.organizationMember.findUnique({
        where: { orgId_userId: { orgId, userId: user.id } },
        select: { id: true }
    });
    if (already) throw new OrgError("They are already on this roster");

    await assertRoom(orgId, user.id);

    await prisma.organizationInvitation.upsert({
        where: { orgId_userId: { orgId, userId: user.id } },
        create: { orgId, userId: user.id, role, invitedById, expiresAt: expiry() },
        update: { role, invitedById, expiresAt: expiry() }
    });

    const inviter = await prisma.user.findUnique({
        where: { id: invitedById },
        select: { name: true, username: true }
    });
    const from = inviter?.name || (inviter?.username ? `@${inviter.username}` : "Somebody");
    // Never fails the invitation: the row is the thing, and the alert is how
    // they find out it is there.
    await notify({
        userId: user.id,
        event: "account.orgInvite",
        title: `${from} invited you to ${org.name}`,
        body: "Accept it to join, or turn it down. Nothing happens until you do.",
        href: "/account/organizations",
        actionRequired: true
    }).catch(() => undefined);
}

/**
 * Refuse an organization that is already at the size this Polaris allows.
 *
 * Pending invitations count. Without that, twenty invitations against a
 * ten-member cap are ten people who accept and ten who are told the room is full
 * by an organization that asked them to come.
 *
 * The person being made room for is left out of that count, and it is the whole
 * reason this takes an id. Their own invitation is still on the table while they
 * accept it and while it is being re-issued at a different role, so counting it
 * as well as the place it is asking for is counting one person twice - which
 * refuses the last invitation an organization is allowed to make, and then
 * refuses to let that person in at all.
 */
async function assertRoom(orgId: string, forUserId: string): Promise<void> {
    const policy = await organizationPolicy();
    const [members, invited] = await Promise.all([
        prisma.organizationMember.count({ where: { orgId } }),
        prisma.organizationInvitation.count({
            where: { orgId, ...live(), userId: { not: forUserId } }
        })
    ]);
    if (!core.withinLimit(policy.maxMembers, members + invited + 1)) {
        throw new OrgError(
            `This organization is at the ${policy.maxMembers}-member limit for this Polaris, counting invitations nobody has answered`
        );
    }
}

/** Refuse a role this organization does not have. A slug arrives from a form, so
 *  it is a claim like any other. */
async function assertRoleExists(orgId: string, slug: string): Promise<void> {
    const role = await prisma.orgRole.findUnique({
        where: { orgId_slug: { orgId, slug } },
        select: { id: true }
    });
    if (!role) throw new OrgError("This organization has no role by that name");
}

/** Everybody this organization is waiting on. */
export async function listOrgInvitations(
    orgId: string,
    viewer: { id: string; isAdmin: boolean }
): Promise<OrgInvitationView[]> {
    const rows = await prisma.organizationInvitation.findMany({
        where: { orgId, ...live() },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            role: true,
            createdAt: true,
            expiresAt: true,
            org: { select: { id: true, name: true, slug: true, roles: { select: { slug: true, name: true } } } },
            user: { select: { id: true, name: true, email: true, username: true } },
            invitedBy: { select: { name: true, username: true } }
        }
    });
    const contacts = await contactLines(
        viewer,
        rows.map((row) => row.user)
    );
    return rows.map((row) => drawn(row, contacts.get(row.user.id) ?? ""));
}

/** Every organization waiting on this account's answer. */
export async function listMyInvitations(userId: string): Promise<OrgInvitationView[]> {
    const rows = await prisma.organizationInvitation.findMany({
        where: { userId, ...live() },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            role: true,
            createdAt: true,
            expiresAt: true,
            org: { select: { id: true, name: true, slug: true, roles: { select: { slug: true, name: true } } } },
            user: { select: { id: true, name: true, email: true, username: true } },
            invitedBy: { select: { name: true, username: true } }
        }
    });
    // Their own row, so there is nothing to withhold from them about themselves.
    return rows.map((row) => drawn(row, ""));
}

type InvitationRow = {
    id: string;
    role: string;
    createdAt: Date;
    expiresAt: Date;
    org: { id: string; name: string; slug: string; roles: { slug: string; name: string }[] };
    user: { id: string; name: string; email: string; username: string | null };
    invitedBy: { name: string; username: string | null };
};

function drawn(row: InvitationRow, contact: string): OrgInvitationView {
    return {
        id: row.id,
        orgId: row.org.id,
        orgName: row.org.name,
        orgSlug: row.org.slug,
        userId: row.user.id,
        name: row.user.name || (row.user.username ? `@${row.user.username}` : "Somebody"),
        contact,
        role: row.role,
        roleName:
            row.org.roles.find((role) => role.slug === row.role)?.name ??
            core.ORG_SYSTEM_ROLES[row.role]?.name ??
            row.role,
        invitedBy: row.invitedBy.name || (row.invitedBy.username ? `@${row.invitedBy.username}` : "Somebody"),
        invitedAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString()
    };
}

/** Withdraw one. The organization's own act, so it names the organization as
 *  well as the invitation - an id on its own would let anybody who has one
 *  cancel an invitation somewhere they cannot see. */
export async function revokeOrgInvitation(orgId: string, invitationId: string): Promise<void> {
    await prisma.organizationInvitation.deleteMany({ where: { id: invitationId, orgId } });
}

/**
 * Answer one.
 *
 * Only the person asked, and everything is re-checked here rather than trusted
 * from the screen that drew the button: between the invitation and the answer
 * the role may have been deleted, the organization may have filled up, and the
 * week may have run out.
 */
export async function respondToInvitation(
    userId: string,
    invitationId: string,
    accept: boolean
): Promise<{ orgId: string; orgSlug: string; orgName: string }> {
    const invitation = await prisma.organizationInvitation.findUnique({
        where: { id: invitationId },
        select: {
            id: true,
            role: true,
            userId: true,
            expiresAt: true,
            invitedById: true,
            org: { select: { id: true, name: true, slug: true } }
        }
    });
    if (!invitation || invitation.userId !== userId) {
        throw new OrgError("That invitation is no longer waiting");
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
        await prisma.organizationInvitation.deleteMany({ where: { id: invitation.id } });
        throw new OrgError("That invitation has expired. Ask them to send another");
    }

    const org = invitation.org;
    if (!accept) {
        await prisma.organizationInvitation.deleteMany({ where: { id: invitation.id } });
        return { orgId: org.id, orgSlug: org.slug, orgName: org.name };
    }

    await ensureSystemRoles(org.id);
    // A role deleted while the invitation sat unanswered would otherwise resolve
    // to the seeded fallback, quietly granting something nobody chose.
    await assertRoleExists(org.id, invitation.role);
    await assertRoom(org.id, userId);

    await prisma.$transaction([
        prisma.organizationMember.upsert({
            where: { orgId_userId: { orgId: org.id, userId } },
            create: { orgId: org.id, userId, role: invitation.role },
            update: { role: invitation.role }
        }),
        prisma.organizationInvitation.deleteMany({ where: { id: invitation.id } })
    ]);

    const joined = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, username: true }
    });
    await notify({
        userId: invitation.invitedById,
        event: "account.orgInvite",
        title: `${joined?.name || (joined?.username ? `@${joined.username}` : "Somebody")} joined ${org.name}`,
        href: `/account/organizations/${org.slug}/people`
    }).catch(() => undefined);

    return { orgId: org.id, orgSlug: org.slug, orgName: org.name };
}
