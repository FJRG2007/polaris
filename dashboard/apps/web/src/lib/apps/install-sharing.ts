/**
 * Giving somebody else access to a server you run.
 *
 * The whole point is that this does not go through an administrator. Whoever runs
 * a game server can bring in a moderator from the server's own screen, pick what
 * that person may do there, and never touch the instance's roles - which is what
 * makes "let them kick players on this one server and nothing else" a thing
 * somebody can actually express.
 *
 * Everything that stops it becoming a way to escalate lives here, in the service,
 * and not in the dialog:
 *
 *   - what is offered is exactly what the sharer holds on this server;
 *   - the right to pass it on can only be given by somebody who holds it;
 *   - an end date is clamped to the sharer's own, so a helper cannot outlive them;
 *   - the grant is always an allow - writing a deny stays with the owner and the
 *     administrator, so somebody who was let in cannot deny the owner off it;
 *   - a new account is created with the instance's chosen role, which is `guest`
 *     by default and grants nothing at all;
 *   - and an invite is re-checked when it is claimed, against what the inviter
 *     still holds. An invite must not be a way to hand out reach you have lost.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { createInvite } from "@/lib/invite-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { canDelegateShare, sharingPolicy } from "@/lib/sharing-policy";
import { grantsOnResource, removeResourceGrant, setResourceGrant } from "@polaris/auth";
import { gamePermissionsFor, installRef, requireGameServer, sharingRightsFor } from "@/lib/apps/install-access";

/** How many people one account may bring in per hour, per server. */
const SHARE_LIMIT = 10;
const SHARE_WINDOW_MS = 60 * 60 * 1000;

/** One line of the "who can reach this" table. */
export interface InstallAccessEntry {
    /** Null on the owner, who is not a grant and cannot be removed. */
    readonly grantId: string | null;
    readonly principalType: "owner" | "user" | "group" | "role";
    readonly label: string;
    readonly actions: core.Permission[];
    readonly canShare: boolean;
    readonly expiresAt: string | null;
    /** Kept in the list once it lapses, so somebody reading it sees why access
     *  stopped rather than a row that quietly vanished. */
    readonly expired: boolean;
}

export interface InstallAccessView {
    readonly entries: InstallAccessEntry[];
    /** Whether the viewer may give access at all, and why not when they may not. */
    readonly canShare: boolean;
    readonly shareRefusal: string | null;
    /** What they may hand out - never more than they hold themselves. */
    readonly grantable: core.Permission[];
    /** Whether they may invite an address with no account yet. */
    readonly canInvite: boolean;
    /** The furthest end date they may set, when their own access ends. */
    readonly until: string | null;
}

/** Names for the principals a grant can point at, resolved in one pass. */
async function labelsFor(
    grants: readonly { principalType: string; principalId: string }[]
): Promise<Map<string, string>> {
    const byType = (type: string) =>
        grants.filter((grant) => grant.principalType === type).map((grant) => grant.principalId);
    const [users, groups, roles] = await Promise.all([
        prisma.user.findMany({
            where: { id: { in: byType("user") } },
            select: { id: true, name: true, username: true }
        }),
        prisma.group.findMany({ where: { id: { in: byType("group") } }, select: { id: true, name: true } }),
        prisma.role.findMany({ where: { id: { in: byType("role") } }, select: { id: true, name: true } })
    ]);
    const labels = new Map<string, string>();
    // The handle rather than the address: this list is read by everybody
    // the server was shared with.
    for (const user of users) {
        labels.set(`user:${user.id}`, user.username ? `${user.name} (@${user.username})` : user.name);
    }
    for (const group of groups) labels.set(`group:${group.id}`, `${group.name} (group)`);
    for (const role of roles) labels.set(`role:${role.id}`, `${role.name} (role)`);
    return labels;
}

/** Who can reach one server, and what this viewer may do about it. */
export async function listInstallAccess(installedAppId: string): Promise<InstallAccessView> {
    const { user, access } = await requireGameServer("games.read", installedAppId);
    const ref = installRef(installedAppId);
    const [grants, held, rights, policy, owner] = await Promise.all([
        grantsOnResource(ref),
        gamePermissionsFor(user, installedAppId),
        sharingRightsFor(user, installedAppId, access.ownerId),
        sharingPolicy(),
        prisma.user.findUnique({
            where: { id: access.ownerId },
            select: { name: true, username: true }
        })
    ]);
    const verdict = await canDelegateShare({ isAdmin: user.isAdmin, mayPassOn: rights.mayPassOn });
    const labels = await labelsFor(grants);
    const now = Date.now();

    const entries: InstallAccessEntry[] = [
        {
            grantId: null,
            principalType: "owner",
            label: owner ? (owner.username ? `${owner.name} (@${owner.username})` : owner.name) : "The owner",
            actions: ["games.read", "games.moderate", "games.manage"],
            canShare: true,
            expiresAt: null,
            expired: false
        },
        ...grants.map((grant) => ({
            grantId: grant.id,
            principalType: grant.principalType,
            label: labels.get(`${grant.principalType}:${grant.principalId}`) ?? grant.principalId,
            actions: grant.actions,
            canShare: grant.canShare,
            expiresAt: grant.expiresAt?.toISOString() ?? null,
            expired: grant.expiresAt !== null && grant.expiresAt.getTime() <= now
        }))
    ];

    return {
        entries,
        canShare: verdict.ok,
        shareRefusal: verdict.ok ? null : verdict.reason,
        grantable: held,
        canInvite: verdict.ok && (user.isAdmin || core.mayInviteStrangers(policy)),
        until: rights.until?.toISOString() ?? null
    };
}

export interface ShareInstallInput {
    readonly installedAppId: string;
    /** An email or a username, which is what somebody sharing has in front of them. */
    readonly identifier: string;
    readonly actions: readonly core.Permission[];
    readonly canShare: boolean;
    /** Null for no end date. */
    readonly expiresInDays: number | null;
}

export interface ShareInstallResult {
    /** Set when the person already had an account and now simply has access. */
    readonly granted?: true;
    /** Set when an invite had to be created, with what to hand over. */
    readonly invite?: { url?: string; sendError?: string };
    readonly error?: string;
}

/** Give somebody access to one server, inviting them first if they have no account. */
export async function shareInstall(input: ShareInstallInput): Promise<ShareInstallResult> {
    const { user, access } = await requireGameServer("games.read", input.installedAppId);
    const ref = installRef(input.installedAppId);
    const identifier = input.identifier.trim().toLowerCase();
    if (!identifier) return { error: "Enter an email address or a username" };

    const [held, rights, policy] = await Promise.all([
        gamePermissionsFor(user, input.installedAppId),
        sharingRightsFor(user, input.installedAppId, access.ownerId),
        sharingPolicy()
    ]);

    // Never more than the sharer holds here. Computed rather than trusted: the
    // dialog offers this same set, and this is what makes that a convenience.
    //
    // Expanded here as well as on the write, so an invite says exactly what it
    // will hand over rather than the shorter list somebody happened to tick - a
    // moderator who cannot read the server they moderate is a promise that only
    // looks narrower than it is.
    const actions = core.expandPermissions(
        core.grantableActions(
            "install",
            input.actions.filter((action) => held.includes(action))
        )
    );
    if (actions.length === 0) return { error: "Choose at least one thing they may do" };
    // Passing it on is only ever passed on by somebody who holds it.
    const canShare = input.canShare && (user.isAdmin || access.isOwner || rights.mayPassOn);

    const target = await prisma.user.findFirst({
        where: { OR: [{ email: identifier }, { username: identifier }] },
        select: { id: true, name: true }
    });
    const verdict = await canDelegateShare({
        isAdmin: user.isAdmin,
        mayPassOn: rights.mayPassOn,
        toStranger: target === null
    });
    if (!verdict.ok) return { error: verdict.reason };

    const attempt = await rateLimit(`share:install:${user.id}`, SHARE_LIMIT, SHARE_WINDOW_MS);
    if (!attempt.ok) return { error: "That is a lot of invites at once. Try again in a little while." };

    const expiresAt = clampExpiry(input.expiresInDays, rights.until);

    if (target) {
        if (target.id === access.ownerId) return { error: "They already own this server" };
        await setResourceGrant({
            principalType: "user",
            principalId: target.id,
            ref,
            actions,
            effect: "allow",
            canShare,
            expiresAt,
            grantedById: user.id
        });
        await recordAudit({
            actorId: user.id,
            action: "app.access.grant",
            targetType: "installedApp",
            targetId: input.installedAppId,
            metadata: { to: target.id, actions, canShare, expiresAt: expiresAt?.toISOString() ?? null }
        });
        return { granted: true };
    }

    // Nobody by that name, so this is an invite. It carries what was promised, and
    // the claim narrows it again to whatever the inviter still holds by then.
    if (!identifier.includes("@")) return { error: "No account matches that. Invite them by email address." };
    const created = await createInvite(user.id, {
        email: identifier,
        role: policy.inviteRole,
        method: "link",
        allowedCidrs: [],
        allowedCountries: [],
        allowedContinents: [],
        groupIds: [],
        delegated: true,
        pendingGrant: {
            resourceKind: "install",
            resourceId: input.installedAppId,
            actions,
            canShare,
            expiresAt: expiresAt?.toISOString() ?? null,
            grantedById: user.id
        }
    });
    if (created.error) return { error: created.error };
    await recordAudit({
        actorId: user.id,
        action: "invite.delegate",
        targetType: "invite",
        targetId: created.id,
        metadata: { email: identifier, resourceKind: "install", resourceId: input.installedAppId, actions }
    });
    return {
        invite: {
            ...(created.url ? { url: created.url } : {}),
            ...(created.sendError ? { sendError: created.sendError } : {})
        }
    };
}

/** Take somebody's access away. */
export async function revokeInstallAccess(installedAppId: string, grantId: string): Promise<{ error?: string }> {
    const { user, access } = await requireGameServer("games.read", installedAppId);
    const rights = await sharingRightsFor(user, installedAppId, access.ownerId);
    const verdict = await canDelegateShare({ isAdmin: user.isAdmin, mayPassOn: rights.mayPassOn });
    if (!verdict.ok) return { error: verdict.reason };
    await removeResourceGrant(installRef(installedAppId), grantId);
    await recordAudit({
        actorId: user.id,
        action: "app.access.revoke",
        targetType: "installedApp",
        targetId: installedAppId,
        metadata: { grantId }
    });
    return {};
}

/** An end date, never later than the sharer's own. */
function clampExpiry(days: number | null, until: Date | null): Date | null {
    const wanted = days === null ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    if (!until) return wanted;
    if (!wanted) return until;
    return wanted < until ? wanted : until;
}
