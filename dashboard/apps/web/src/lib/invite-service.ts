/**
 * Invitations. New accounts come only from an admin invite, so this module owns
 * every way one can travel and every condition attached to it.
 *
 * An invite is always a high-entropy token; what changes is how the recipient
 * gets hold of it. A link invite is handed over by the administrator, a magic
 * invite is emailed by Polaris, and a code invite is redeemed by typing a short
 * code on the join page. Neither the token nor the code is ever stored - only
 * their SHA-256 - so a database dump cannot be used to accept anything. An
 * optional one-time password, communicated out of band, is stretched with the
 * same slow KDF as a share password: it is short and human-chosen, and it is
 * what makes a link that lands in the wrong inbox worthless on its own.
 *
 * The network rules on an invite do double duty: they bound where it may be
 * claimed from, and they become the account's enforced sign-in restrictions the
 * moment it exists. One rule set, so what an administrator wrote down when
 * inviting someone is what governs the account afterwards.
 */

import { auth } from "@/lib/auth";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { sendAuthEmail } from "@/lib/auth-mail";
import { recordAudit } from "@/lib/audit-service";
import { appBaseUrl } from "@/lib/domain-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { evaluateNetworkRules } from "@/lib/network-rules";
import { generateShortCode, generateToken, hashToken } from "@polaris/core/tokens";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";
import {
    assignRole,
    canOn,
    emailOwner,
    provisionUser,
    seedDefaultRoles,
    setResourceGrant,
    updateEnforcedRules
} from "@polaris/auth";
import {
    INVITE_CODE_LENGTH,
    normalizeInviteCode,
    parseStringList,
    stringifyList,
    unionRules,
    type AccessRulesInput,
    type CreateInviteInput,
    type EffectiveAccessRules,
    type InviteMethod,
    type InviteRefusal
} from "@polaris/core";

/** Seven days, the invite lifetime. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Claim attempts allowed from one address per window, so a code cannot be
 *  guessed at machine speed. The window is long enough to be a real ceiling and
 *  short enough that a person who mistypes twice is not locked out for the day. */
const CLAIM_ATTEMPT_LIMIT = 10;
const CLAIM_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

/** An invite resolved for the join page: enough to render it, nothing more. */
export interface InviteView {
    id: string;
    email: string;
    method: InviteMethod;
    /** Whether a one-time password must be presented alongside the link or code. */
    needsPassword: boolean;
}

interface InviteRow {
    id: string;
    email: string;
    method: string;
    passwordHash: string | null;
    acceptedAt: Date | null;
    expiresAt: Date;
    roleId: string | null;
    invitedById: string;
    allowedCidrs: string;
    allowedCountries: string;
    allowedContinents: string;
    accessGroupIds: string;
    pendingGrant: string | null;
}

const INVITE_FIELDS = {
    id: true,
    email: true,
    method: true,
    passwordHash: true,
    acceptedAt: true,
    expiresAt: true,
    roleId: true,
    invitedById: true,
    allowedCidrs: true,
    allowedCountries: true,
    allowedContinents: true,
    accessGroupIds: true,
    pendingGrant: true
} as const;

/** The URL a link or magic invite is claimed at. Built on the address Polaris is
 *  reachable at from outside, not the LAN-only name the installer configures - an
 *  invite is by definition handed to somebody who is not on this network. */
export async function inviteUrl(token: string): Promise<string> {
    return `${await appBaseUrl()}/oauth/accept-invite?token=${encodeURIComponent(token)}`;
}

function inviteMessage(url: string): { text: string; html: string } {
    const text = [
        "You have been invited to Polaris.",
        "",
        url,
        "",
        "The link expires in 7 days. If you were not expecting this, ignore this message."
    ].join("\n");
    const html = [
        "<p>You have been invited to Polaris.</p>",
        `<p><a href="${url}">Accept your invite</a></p>`,
        "<p>The link expires in 7 days. If you were not expecting this, ignore this message.</p>"
    ].join("");
    return { text, html };
}

/** What an invite hands back to the administrator who created it. */
export interface CreatedInvite {
    id: string;
    /** The claim URL, for the methods that travel as one. */
    url?: string;
    /** The code to read out, for the method that travels as one. */
    code?: string;
    /** Why Polaris could not email it, when it was asked to. */
    sendError?: string;
    /** Why nothing was created at all. */
    error?: string;
}

/**
 * Refuse an invite that cannot become an account. Both checks are the same
 * refusal the claim would end in anyway - provisionUser will not create a second
 * account under an address somebody already holds - so they are made here, where
 * the administrator can still do something about it, instead of days later in
 * front of the person who followed the link.
 *
 * The address is judged against every address an account holds, alternates
 * included: an alternate is one its owner has proved, and inviting it would be
 * inviting them a second time.
 */
async function inviteRefusal(email: string): Promise<string | null> {
    if (await emailOwner(email)) {
        return "That address already has an account. Change their role from the people list instead.";
    }
    const open = await prisma.invite.findFirst({
        where: { email, acceptedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true }
    });
    if (open) return "There is already an open invite for that address. Revoke it before sending another.";
    return null;
}

export async function createInvite(
    invitedById: string,
    input: CreateInviteInput
): Promise<CreatedInvite> {
    await seedDefaultRoles();
    const email = input.email.trim().toLowerCase();
    const refusal = await inviteRefusal(email);
    if (refusal) return { id: "", error: refusal };

    // Roles are rows an operator can add to, so an unknown name is a mistake to
    // report rather than an invite that quietly hands out nothing.
    const role = await prisma.role.findUnique({ where: { name: input.role }, select: { id: true } });
    if (!role) return { id: "", error: "That role no longer exists." };
    const token = generateToken();
    // Only the groups the inviting administrator owns; a foreign id is dropped
    // rather than rejected, the same way every other rule editor treats one.
    const groups = await prisma.accessGroup.findMany({
        where: { ownerId: invitedById, id: { in: input.groupIds } },
        select: { id: true }
    });
    const code = input.method === "code" ? generateShortCode(INVITE_CODE_LENGTH) : null;

    const invite = await prisma.invite.create({
        data: {
            email,
            tokenHash: hashToken(token),
            codeHash: code ? hashToken(code) : null,
            passwordHash: input.oneTimePassword ? await hashLinkPassword(input.oneTimePassword) : null,
            method: input.method,
            roleId: role.id,
            invitedById,
            expiresAt: new Date(Date.now() + INVITE_TTL_MS),
            allowedCidrs: stringifyList(input.allowedCidrs),
            allowedCountries: stringifyList(input.allowedCountries),
            allowedContinents: stringifyList(input.allowedContinents),
            accessGroupIds: stringifyList(groups.map((group) => group.id)),
            delegated: input.delegated === true,
            // What it promises on one thing. Only an intention until the claim,
            // which resolves it again against what the inviter still holds.
            pendingGrant: input.pendingGrant ? JSON.stringify(input.pendingGrant) : null
        },
        select: { id: true }
    });

    const url = await inviteUrl(token);
    if (input.method === "magic") {
        const sent = await sendAuthEmail({ to: email, subject: "You have been invited to Polaris", ...inviteMessage(url) });
        if (sent.error) return { id: invite.id, url, sendError: sent.error };
        await prisma.invite.update({ where: { id: invite.id }, data: { sentAt: new Date() } });
        return { id: invite.id, url };
    }
    if (code) return { id: invite.id, code };
    return { id: invite.id, url };
}

/** The rules an invite imposes, in the shape the evaluator takes. */
function inviteRules(invite: InviteRow): EffectiveAccessRules {
    return unionRules([invite]);
}

/** Look an invite up by whichever credential the recipient presented. */
async function findInvite(credential: { token?: string; code?: string }): Promise<InviteRow | null> {
    if (credential.token) {
        return prisma.invite.findUnique({ where: { tokenHash: hashToken(credential.token) }, select: INVITE_FIELDS });
    }
    if (credential.code) {
        const normalized = normalizeInviteCode(credential.code);
        if (normalized.length !== INVITE_CODE_LENGTH) return null;
        return prisma.invite.findUnique({ where: { codeHash: hashToken(normalized) }, select: INVITE_FIELDS });
    }
    return null;
}

/** Whether an invite is still open, before any of its conditions are checked. */
function isOpen(invite: InviteRow): boolean {
    return invite.acceptedAt === null && invite.expiresAt.getTime() >= Date.now();
}

/**
 * Spend one attempt from the address's budget. Both the code and the one-time
 * password are short enough to guess at machine speed; the ceiling is per
 * address, so one attacker cannot spend everybody else's attempts.
 */
async function claimAttemptAllowed(ip: string | undefined): Promise<boolean> {
    const attempt = await rateLimit(
        `invite:claim:${ip ?? "unknown"}`,
        CLAIM_ATTEMPT_LIMIT,
        CLAIM_ATTEMPT_WINDOW_MS
    );
    return attempt.ok;
}

/**
 * Resolve an invite for the join page. The address is judged here as well as at
 * acceptance: showing somebody a form they will be refused at the end of wastes
 * their time, and the rules are not a secret from the person holding the invite.
 *
 * Every refusal below reads the same to the caller beyond the reason code - an
 * invite that never existed and one that was already claimed are one answer, so
 * a stranger with a token cannot learn which.
 */
export async function resolveInvite(
    credential: { token?: string; code?: string },
    ip: string | undefined
): Promise<{ invite?: InviteView; refusal?: InviteRefusal }> {
    // Looking a code up is already a guess at it, and shares the claim budget.
    // A token is 256 bits wide and needs no such ceiling.
    if (credential.code && !(await claimAttemptAllowed(ip))) return { refusal: "throttled" };

    const invite = await findInvite(credential);
    if (!invite || !isOpen(invite)) return { refusal: "unavailable" };
    const decision = await evaluateNetworkRules(inviteRules(invite), ip);
    if (!decision.allowed) return { refusal: "location" };
    return {
        invite: {
            id: invite.id,
            email: invite.email,
            method: (invite.method as InviteMethod) ?? "link",
            needsPassword: invite.passwordHash !== null
        }
    };
}

/** The rules an invite leaves behind on the account it created. */
function enforcedFromInvite(invite: InviteRow): AccessRulesInput {
    return {
        groupIds: parseStringList(invite.accessGroupIds),
        allowedCidrs: parseStringList(invite.allowedCidrs),
        allowedCountries: parseStringList(invite.allowedCountries),
        allowedContinents: parseStringList(invite.allowedContinents)
    };
}

/**
 * Give the new account the access its invite promised, narrowed to what the
 * person who sent it still holds.
 *
 * An invite is written now and claimed later, and in between the sender can have
 * lost the very reach they were passing on - their own grant revoked, or expired.
 * Re-resolving here is what stops an invite becoming a way to hand out access
 * somebody no longer has. Nothing left after the narrowing means no grant at all,
 * and the account simply arrives with whatever its role gives it.
 *
 * Never fatal. Somebody standing on the join page has typed a password and is
 * waiting; an access rule that could not be written is worth an audit entry and a
 * conversation, not a refusal to create the account they were invited to.
 */
async function applyPendingGrant(invite: InviteRow, userId: string): Promise<void> {
    const promised = core.parsePendingGrant(invite.pendingGrant);
    if (!promised) return;
    const ref = core.resourceRef(promised.resourceKind, promised.resourceId);
    try {
        const inviter = await prisma.user.findUnique({
            where: { id: promised.grantedById },
            select: { id: true, isAdmin: true }
        });
        if (!inviter) return;
        const still = inviter.isAdmin
            ? [...promised.actions]
            : (
                  await Promise.all(
                      promised.actions.map(async (action) =>
                          (await canOn(inviter.id, action, ref)) ? action : null
                      )
                  )
              ).filter((action): action is core.Permission => action !== null);
        if (still.length === 0) return;
        await setResourceGrant({
            principalType: "user",
            principalId: userId,
            ref,
            actions: still,
            effect: "allow",
            canShare: promised.canShare,
            expiresAt: promised.expiresAt ? new Date(promised.expiresAt) : null,
            grantedById: promised.grantedById
        });
        await recordAudit({
            actorId: promised.grantedById,
            action: "app.access.grant",
            targetType: ref.kind === "install" ? "installedApp" : ref.kind,
            targetId: ref.id,
            metadata: { to: userId, actions: still, via: "invite" }
        });
    } catch {
        // The account is made and its role assigned either way.
    }
}

export interface ClaimInput {
    token?: string;
    code?: string;
    oneTimePassword?: string;
    name: string;
    username: string;
    password: string;
    ip: string | undefined;
}

/**
 * Claim an invite: create the credentialed user, give them the invited role, and
 * carry the invite's restrictions onto the account as limits it cannot remove.
 *
 * Every condition is re-checked here rather than trusted from the page that
 * rendered the form: the form is the client's, and between rendering it and
 * submitting it the invite may have been revoked, expired, claimed by somebody
 * else, or carried to another network.
 */
export async function claimInvite(input: ClaimInput): Promise<{ email?: string; refusal?: InviteRefusal; error?: string }> {
    if (!(await claimAttemptAllowed(input.ip))) return { refusal: "throttled" };

    const invite = await findInvite({ token: input.token, code: input.code });
    if (!invite || !isOpen(invite)) return { refusal: "unavailable" };

    const decision = await evaluateNetworkRules(inviteRules(invite), input.ip);
    if (!decision.allowed) return { refusal: "location" };

    if (invite.passwordHash) {
        const presented = input.oneTimePassword ?? "";
        if (!presented || !(await verifyLinkPassword(presented, invite.passwordHash))) {
            return { refusal: "password" };
        }
    }

    let user: { id: string };
    try {
        user = await provisionUser(auth, {
            email: invite.email,
            name: input.name,
            username: input.username,
            password: input.password
        });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not accept the invite" };
    }

    if (invite.roleId) {
        const role = await prisma.role.findUnique({ where: { id: invite.roleId }, select: { name: true } });
        if (role) await assignRole(user.id, role.name);
    }

    const rules = enforcedFromInvite(invite);
    const restricted =
        rules.groupIds.length > 0 ||
        rules.allowedCidrs.length > 0 ||
        rules.allowedCountries.length > 0 ||
        rules.allowedContinents.length > 0;
    if (restricted) await updateEnforcedRules(user.id, invite.invitedById, rules);

    await applyPendingGrant(invite, user.id);

    await prisma.$transaction([
        prisma.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
        // A magic invite was read out of the mailbox it was sent to, which is the
        // same proof the verification link asks for. Nothing else is: a link or a
        // code can reach the recipient any way at all.
        ...(invite.method === "magic"
            ? [prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } })]
            : [])
    ]);

    return { email: invite.email };
}

/** One pending invite, as the administrator's list shows it. */
export interface InviteListItem {
    id: string;
    email: string;
    method: InviteMethod;
    role: string | null;
    needsPassword: boolean;
    restricted: boolean;
    sentAt: string | null;
    expiresAt: string;
    createdAt: string;
}

export async function listInvites(): Promise<InviteListItem[]> {
    const rows = await prisma.invite.findMany({
        where: { acceptedAt: null },
        select: {
            id: true,
            email: true,
            method: true,
            roleId: true,
            passwordHash: true,
            sentAt: true,
            expiresAt: true,
            createdAt: true,
            allowedCidrs: true,
            allowedCountries: true,
            allowedContinents: true,
            accessGroupIds: true
        },
        orderBy: { createdAt: "desc" }
    });
    // The invite keeps only the role id (the row it points at is not its own), so
    // the names are resolved in one query rather than one per invite.
    const roles = await prisma.role.findMany({
        where: { id: { in: rows.map((row) => row.roleId).filter((id): id is string => id !== null) } },
        select: { id: true, name: true }
    });
    const roleName = new Map(roles.map((role) => [role.id, role.name]));

    return rows.map((row) => ({
        id: row.id,
        email: row.email,
        method: (row.method as InviteMethod) ?? "link",
        role: row.roleId ? (roleName.get(row.roleId) ?? null) : null,
        needsPassword: row.passwordHash !== null,
        restricted:
            parseStringList(row.allowedCidrs).length > 0 ||
            parseStringList(row.allowedCountries).length > 0 ||
            parseStringList(row.allowedContinents).length > 0 ||
            parseStringList(row.accessGroupIds).length > 0,
        sentAt: row.sentAt?.toISOString() ?? null,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString()
    }));
}

export async function revokeInvite(id: string): Promise<void> {
    await prisma.invite.deleteMany({ where: { id, acceptedAt: null } });
}
