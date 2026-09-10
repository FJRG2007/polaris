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
import { contactLines } from "@/lib/privacy-service";
import { notify } from "@/lib/notifications/dispatch";
import { ensureSystemRoles, roleIsRestricted } from "./role-service";

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

/** What sending an invitation came to: an account asked in the app, or an
 *  address with no account emailed a link that makes one. */
export type SentInvitation =
    | { readonly kind: "account"; readonly userId: string }
    | {
          readonly kind: "email";
          readonly inviteId: string;
          /** The link, when the mail could not be sent, so it can be handed over. */
          readonly url?: string;
          readonly sendError?: string;
      };

/** The audit actions an invitation writes, which is what the per-person budget
 *  counts. Kept here so the counter and the writers cannot disagree. */
export const INVITE_BUDGET_ACTIONS = ["org.member.invite", "org.member.invite.resend"] as const;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Refuse a person who has already sent as many invitations from this
 * organization in the last hour as this Polaris allows.
 *
 * A sliding hour, counted from the trail's own record of the invitations they
 * sent rather than from a counter: the trail is the authoritative account of who
 * invited whom, it is already indexed by person and by organization, and a
 * window that slides has no moment at the top of the hour when the whole budget
 * comes back at once. An invitation to an address with no account sends mail
 * from this Polaris to a stranger, which is the thing this exists to bound.
 */
export async function assertInviteBudget(orgId: string, inviterId: string): Promise<void> {
    const { invitesPerHour } = await organizationPolicy();
    if (invitesPerHour === 0) return;
    const sent = await prisma.auditLog.count({
        where: {
            orgId,
            actorId: inviterId,
            action: { in: [...INVITE_BUDGET_ACTIONS] },
            at: { gte: new Date(Date.now() - HOUR_MS) }
        }
    });
    if (sent >= invitesPerHour) {
        throw new OrgError(
            `You have sent ${invitesPerHour} invitations from this organization in the last hour, which is as many as this Polaris allows. Try again later.`
        );
    }
}

/**
 * Ask somebody, by the address or handle whoever is doing it has in front of
 * them.
 *
 * Somebody with an account is asked in the app. An address with no account
 * behind it is emailed a link that makes one and joins the organization in the
 * same step - when this Polaris lets the person asking do that, which by default
 * only its administrators may, because it creates an account here.
 *
 * Asking an account again replaces the invitation rather than failing: changing
 * your mind about the role you offered is the same act, and a second row for the
 * same pair is a roster with two answers to one question.
 *
 * Answers with what it resolved to, which is what anything downstream is allowed
 * to keep: the identifier is somebody's address as often as not, and it stops
 * here.
 */
export async function inviteToOrg(
    orgId: string,
    identifier: string,
    role: string,
    invitedBy: { id: string; isAdmin: boolean }
): Promise<SentInvitation> {
    await ensureSystemRoles(orgId);
    await assertRoleExists(orgId, role);
    await assertInviteBudget(orgId, invitedBy.id);
    const invitedById = invitedBy.id;

    const needle = identifier.trim().toLowerCase();
    const user = await prisma.user.findFirst({
        where: { OR: [{ email: needle }, { username: needle }] },
        select: { id: true, bannedAt: true }
    });
    if (!user) {
        if (!core.isEmailIdentifier(needle)) throw new OrgError("No account matches that username");
        return inviteByEmail(orgId, needle, role, invitedBy);
    }
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

    return { kind: "account", userId: user.id };
}

/** How the person sending an invitation reads to whoever receives it. */
async function inviterName(inviterId: string): Promise<string> {
    const inviter = await prisma.user.findUnique({
        where: { id: inviterId },
        select: { name: true, username: true }
    });
    return inviter?.name || (inviter?.username ? `@${inviter.username}` : "Somebody");
}

/**
 * Invite an address that has no account yet.
 *
 * Only when this Polaris allows the person asking to: an account here is
 * otherwise something only an administrator makes, so that is the default, and
 * the refusal names the setting that changes it rather than leaving somebody
 * guessing why the address "has no account".
 *
 * The invite is the instance's own - the same hashed, single-use, week-long link
 * an administrator sends - carrying the organization and the role, so accepting
 * it makes the account and joins the roster in one step.
 */
async function inviteByEmail(
    orgId: string,
    email: string,
    role: string,
    invitedBy: { id: string; isAdmin: boolean }
): Promise<SentInvitation> {
    const policy = await organizationPolicy();
    if (policy.newPeople === "off") {
        throw new OrgError("No account matches that email, and this Polaris only lets organizations invite people who already have one");
    }
    if (policy.newPeople === "admins" && !invitedBy.isAdmin) {
        throw new OrgError(
            "No account matches that email. Only an administrator can invite somebody who has no account yet; an administrator can allow it under Organizations."
        );
    }

    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    if (!org) throw new OrgError("That organization no longer exists");
    await assertRoom(orgId, null);

    const { createInvite } = await import("@/lib/invite-service");
    const { sharingPolicy } = await import("@/lib/sharing-policy");
    const created = await createInvite(
        invitedBy.id,
        {
            email,
            // The instance role an account made this way arrives with - the same
            // one an account shared into existence gets, set under Users.
            role: (await sharingPolicy()).inviteRole,
            method: "magic",
            allowedCidrs: [],
            allowedCountries: [],
            allowedContinents: [],
            groupIds: [],
            delegated: !invitedBy.isAdmin
        },
        { org: { id: orgId, name: org.name, role, inviter: await inviterName(invitedBy.id) } }
    );
    if (created.error) throw new OrgError(created.error);
    return {
        kind: "email",
        inviteId: created.id,
        ...(created.sendError ? { url: created.url, sendError: created.sendError } : {})
    };
}

/** One emailed invitation somebody with no account has not answered yet. */
export interface OrgEmailInviteView {
    readonly id: string;
    /** Whole for whoever runs the roster, who typed it; masked for everybody else. */
    readonly email: string;
    readonly role: string;
    readonly roleName: string;
    readonly invitedBy: string;
    readonly sentAt: string | null;
    readonly expiresAt: string;
}

/** "ana@example.com" as "a***@example.com": enough to recognise, not to copy. */
function maskEmail(email: string): string {
    const at = email.indexOf("@");
    if (at <= 0) return "***";
    return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** Everybody this organization has emailed and not heard back from. */
export async function listOrgEmailInvites(
    orgId: string,
    options: { canManage: boolean }
): Promise<OrgEmailInviteView[]> {
    const [rows, roles] = await Promise.all([
        prisma.invite.findMany({
            where: { orgId, acceptedAt: null, expiresAt: { gt: new Date() } },
            orderBy: { createdAt: "asc" },
            select: {
                id: true,
                email: true,
                orgRole: true,
                sentAt: true,
                expiresAt: true,
                invitedBy: { select: { name: true, username: true } }
            }
        }),
        prisma.orgRole.findMany({ where: { orgId }, select: { slug: true, name: true } })
    ]);
    return rows.map((row) => {
        const role = row.orgRole ?? core.DEFAULT_ORG_ROLE;
        return {
            id: row.id,
            email: options.canManage ? row.email : maskEmail(row.email),
            role,
            roleName:
                roles.find((entry) => entry.slug === role)?.name ?? core.ORG_SYSTEM_ROLES[role]?.name ?? role,
            invitedBy: row.invitedBy.name || (row.invitedBy.username ? `@${row.invitedBy.username}` : "Somebody"),
            sentAt: row.sentAt?.toISOString() ?? null,
            expiresAt: row.expiresAt.toISOString()
        };
    });
}

/** Send one of this organization's emailed invitations again, under a new link.
 *  Counts against the same budget sending it did. */
export async function resendOrgEmailInvite(
    orgId: string,
    inviteId: string,
    actor: { id: string }
): Promise<{ url?: string; sendError?: string }> {
    await assertInviteBudget(orgId, actor.id);
    const invite = await prisma.invite.findFirst({
        where: { id: inviteId, orgId, acceptedAt: null },
        select: { orgRole: true }
    });
    if (!invite) throw new OrgError("That invitation is no longer waiting");
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    if (!org) throw new OrgError("That organization no longer exists");

    const { resendInvite } = await import("@/lib/invite-service");
    const sent = await resendInvite(inviteId, {
        orgId,
        org: {
            id: orgId,
            name: org.name,
            role: invite.orgRole ?? core.DEFAULT_ORG_ROLE,
            inviter: await inviterName(actor.id)
        }
    });
    if (sent.error) throw new OrgError(sent.error);
    return sent.sendError ? { url: sent.url, sendError: sent.sendError } : {};
}

/** Withdraw one of this organization's emailed invitations. The link stops
 *  working at once; nobody is told. */
export async function revokeOrgEmailInvite(orgId: string, inviteId: string): Promise<void> {
    const gone = await prisma.invite.deleteMany({ where: { id: inviteId, orgId, acceptedAt: null } });
    if (gone.count === 0) throw new OrgError("That invitation is no longer waiting");
}

/**
 * Put the account an emailed invitation just made on the organization's roster.
 *
 * Called from inside the claim, after the account exists. Everything is checked
 * again - the role, the room - and a failure leaves the account made and the
 * roster as it was, with the inviter told: somebody who followed a link and set
 * a password is not turned away at the last step because the organization
 * changed its mind in between.
 *
 * Never throws.
 */
export async function joinOrgFromInvite(input: {
    inviteId: string;
    orgId: string;
    role: string | null;
    userId: string;
    invitedById: string;
}): Promise<boolean> {
    try {
        const org = await prisma.organization.findUnique({
            where: { id: input.orgId },
            select: { id: true, name: true, slug: true, defaultInviteRole: true }
        });
        if (!org) return false;
        await ensureSystemRoles(org.id);

        // The role they were offered, if the organization still has it; its own
        // default otherwise - never a fallback that grants something nobody
        // chose.
        const offered = input.role ?? org.defaultInviteRole;
        const role = (await roleExists(org.id, offered))
            ? offered
            : (await roleExists(org.id, org.defaultInviteRole))
              ? org.defaultInviteRole
              : core.RESTRICTED_ORG_ROLE;

        await assertRoom(org.id, input.userId, input.inviteId);
        await prisma.organizationMember.upsert({
            where: { orgId_userId: { orgId: org.id, userId: input.userId } },
            create: {
                orgId: org.id,
                userId: input.userId,
                role,
                restricted: await roleIsRestricted(org.id, role)
            },
            update: {}
        });

        const { recordAudit } = await import("@/lib/audit-service");
        await recordAudit({
            actorId: input.userId,
            orgId: org.id,
            action: "org.member.invite.accept",
            targetType: "org",
            targetId: org.id,
            metadata: { via: "email", inviteId: input.inviteId, role }
        });
        const joined = await prisma.user.findUnique({
            where: { id: input.userId },
            select: { name: true, username: true }
        });
        await notify({
            userId: input.invitedById,
            event: "account.orgInvite",
            title: `${joined?.name || (joined?.username ? `@${joined.username}` : "Somebody")} joined ${org.name}`,
            href: `/account/organizations/${org.slug}/people`
        }).catch(() => undefined);
        return true;
    } catch (caught) {
        console.error("polaris: an invited account could not join its organization:", caught);
        const org = await prisma.organization
            .findUnique({ where: { id: input.orgId }, select: { name: true, slug: true } })
            .catch(() => null);
        if (org) {
            await notify({
                userId: input.invitedById,
                event: "account.orgInvite",
                title: `Somebody you invited to ${org.name} made an account but could not join`,
                body: caught instanceof OrgError ? caught.message : "Invite them again from People.",
                href: `/account/organizations/${org.slug}/people`
            }).catch(() => undefined);
        }
        return false;
    }
}

async function roleExists(orgId: string, slug: string): Promise<boolean> {
    return (
        (await prisma.orgRole.findUnique({ where: { orgId_slug: { orgId, slug } }, select: { id: true } })) !==
        null
    );
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
 * refuses to let that person in at all. An emailed invitation being accepted is
 * left out the same way, by its own id.
 */
async function assertRoom(
    orgId: string,
    forUserId: string | null,
    exceptInviteId?: string
): Promise<void> {
    const policy = await organizationPolicy();
    const [members, invited, emailed] = await Promise.all([
        prisma.organizationMember.count({ where: { orgId } }),
        prisma.organizationInvitation.count({
            where: { orgId, ...live(), ...(forUserId ? { userId: { not: forUserId } } : {}) }
        }),
        // Invitations emailed to people with no account hold a place too.
        prisma.invite.count({
            where: {
                orgId,
                acceptedAt: null,
                expiresAt: { gt: new Date() },
                ...(exceptInviteId ? { id: { not: exceptInviteId } } : {})
            }
        })
    ]);
    if (!core.withinLimit(policy.maxMembers, members + invited + emailed + 1)) {
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
            org: {
                select: {
                    id: true,
                    name: true,
                    slug: true,
                    roles: { select: { slug: true, name: true } }
                }
            },
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
            org: {
                select: {
                    id: true,
                    name: true,
                    slug: true,
                    roles: { select: { slug: true, name: true } }
                }
            },
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
        invitedBy:
            row.invitedBy.name ||
            (row.invitedBy.username ? `@${row.invitedBy.username}` : "Somebody"),
        invitedAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString()
    };
}

/**
 * Withdraw one. The organization's own act, so it names the organization as
 * well as the invitation - an id on its own would let anybody who has one
 * cancel an invitation somewhere they cannot see.
 *
 * Refused when nothing matched, rather than reported as done: an id belonging
 * to another organization, or to an invitation that was answered a moment ago,
 * would otherwise leave the screen saying it was withdrawn and the history
 * saying somebody withdrew it.
 */
export async function revokeOrgInvitation(orgId: string, invitationId: string): Promise<void> {
    const gone = await prisma.organizationInvitation.deleteMany({
        where: { id: invitationId, orgId }
    });
    if (gone.count === 0) throw new OrgError("That invitation is no longer waiting");
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
): Promise<{ orgId: string; orgSlug: string; orgName: string; restricted: boolean }> {
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
        return { orgId: org.id, orgSlug: org.slug, orgName: org.name, restricted: false };
    }

    await ensureSystemRoles(org.id);
    // A role deleted while the invitation sat unanswered would otherwise resolve
    // to the seeded fallback, quietly granting something nobody chose.
    await assertRoleExists(org.id, invitation.role);
    await assertRoom(org.id, userId);

    const restricted = await roleIsRestricted(org.id, invitation.role);
    await prisma.$transaction([
        prisma.organizationMember.upsert({
            where: { orgId_userId: { orgId: org.id, userId } },
            create: { orgId: org.id, userId, role: invitation.role, restricted },
            update: { role: invitation.role, restricted }
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

    return { orgId: org.id, orgSlug: org.slug, orgName: org.name, restricted };
}
