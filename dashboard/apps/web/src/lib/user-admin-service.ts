/**
 * The people directory behind /admin/users, and every change an administrator
 * can make to somebody else's account.
 *
 * Reading is one query: the directory shows who someone is, what they may do,
 * how they get in, and where from, and answering that per row would be a page of
 * round trips. Writing is one function per decision, each of which records an
 * audit entry - who did what to whom is the whole point of an operator surface.
 *
 * Two guards run through all of it: nobody may act on themselves in a way that
 * locks the instance (a self-ban, a self-demotion, a self-delete), and the last
 * administrator standing cannot be removed, banned or demoted. An instance with
 * no reachable administrator is only recoverable from the database.
 */

import { updateEnforcedRules, type AccessGroupView } from "@polaris/auth";
import { parseStringList, type AccessRulesInput } from "@polaris/core";
import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";

/** One person, as the directory lists them. */
export interface DirectoryUser {
    id: string;
    name: string;
    email: string;
    username: string | null;
    company: string | null;
    isAdmin: boolean;
    banned: boolean;
    banReason: string | null;
    bannedAt: string | null;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
    /** Roles held directly, and the groups they belong to. */
    roles: string[];
    groups: string[];
    /** Live sessions right now, and where the most recent one was last seen. */
    sessions: number;
    lastSeenAt: string | null;
    lastIp: string | null;
    lastCountry: string | null;
    createdAt: string;
    /** The limits an administrator imposed, as the editor reads them back. */
    enforced: AccessRulesInput;
}

/** Everyone, with what the directory needs to describe them. */
export async function listUserDirectory(): Promise<DirectoryUser[]> {
    const rows = await prisma.user.findMany({
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            name: true,
            email: true,
            username: true,
            company: true,
            isAdmin: true,
            bannedAt: true,
            banReason: true,
            emailVerified: true,
            twoFactorEnabled: true,
            createdAt: true,
            roles: { select: { role: { select: { name: true } } } },
            groups: { select: { group: { select: { name: true } } } },
            accessGroupBindings: { where: { enforced: true }, select: { groupId: true } },
            security: { select: { adminCidrs: true, adminCountries: true, adminContinents: true } },
            _count: { select: { sessions: true } },
            // The freshest session tells the directory when this account was last
            // actually used, and from where.
            sessionStates: {
                orderBy: { lastSeenAt: "desc" },
                take: 1,
                select: { lastSeenAt: true, ip: true, country: true }
            }
        }
    });

    return rows.map((row) => {
        const latest = row.sessionStates[0];
        return {
            id: row.id,
            name: row.name,
            email: row.email,
            username: row.username,
            company: row.company,
            isAdmin: row.isAdmin,
            banned: row.bannedAt !== null,
            banReason: row.banReason,
            bannedAt: row.bannedAt?.toISOString() ?? null,
            emailVerified: row.emailVerified,
            twoFactorEnabled: row.twoFactorEnabled,
            roles: row.roles.map((entry) => entry.role.name),
            groups: row.groups.map((entry) => entry.group.name),
            sessions: row._count.sessions,
            lastSeenAt: latest?.lastSeenAt.toISOString() ?? null,
            lastIp: latest?.ip ?? null,
            lastCountry: latest?.country ?? null,
            createdAt: row.createdAt.toISOString(),
            enforced: {
                groupIds: row.accessGroupBindings.map((binding) => binding.groupId),
                allowedCidrs: parseStringList(row.security?.adminCidrs),
                allowedCountries: parseStringList(row.security?.adminCountries),
                allowedContinents: parseStringList(row.security?.adminContinents)
            }
        };
    });
}

/** The access groups an administrator can impose, i.e. the ones they own. */
export async function listImposableGroups(adminId: string): Promise<AccessGroupView[]> {
    const rows = await prisma.accessGroup.findMany({
        where: { ownerId: adminId },
        orderBy: { name: "asc" },
        include: { _count: { select: { apiKeys: true, users: true } } }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        allowedCidrs: parseStringList(row.allowedCidrs),
        allowedCountries: parseStringList(row.allowedCountries),
        allowedContinents: parseStringList(row.allowedContinents),
        apiKeyCount: row._count.apiKeys,
        appliedToSignIn: row._count.users > 0
    }));
}

/** Refuse a change that would leave the instance with no way back in. */
async function wouldStrandInstance(userId: string): Promise<boolean> {
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (!target?.isAdmin) return false;
    const others = await prisma.user.count({ where: { isAdmin: true, bannedAt: null, id: { not: userId } } });
    return others === 0;
}

/** End every session a user holds, so a change to their access is immediate. */
async function dropSessions(userId: string): Promise<void> {
    await prisma.session.deleteMany({ where: { userId } });
}

export async function banUser(actorId: string, userId: string, reason: string): Promise<{ error?: string }> {
    if (userId === actorId) return { error: "You can't ban yourself." };
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) return { error: "User not found." };
    if (await wouldStrandInstance(userId)) return { error: "This is the last administrator." };

    await prisma.user.update({
        where: { id: userId },
        data: { bannedAt: new Date(), banReason: reason.trim() || null }
    });
    // Immediate, rather than only on their next sign-in.
    await dropSessions(userId);
    await recordAudit({ actorId, action: "user.ban", targetType: "user", targetId: userId });
    return {};
}

export async function unbanUser(actorId: string, userId: string): Promise<{ error?: string }> {
    await prisma.user.update({ where: { id: userId }, data: { bannedAt: null, banReason: null } });
    await recordAudit({ actorId, action: "user.unban", targetType: "user", targetId: userId });
    return {};
}

/** Grant or withdraw the administrator gate on operator surfaces. */
export async function setAdminAccess(actorId: string, userId: string, isAdmin: boolean): Promise<{ error?: string }> {
    if (!isAdmin) {
        if (userId === actorId) return { error: "You can't remove your own administrator access." };
        if (await wouldStrandInstance(userId)) return { error: "This is the last administrator." };
    }
    await prisma.user.update({ where: { id: userId }, data: { isAdmin } });
    await recordAudit({
        actorId,
        action: isAdmin ? "user.promote" : "user.demote",
        targetType: "user",
        targetId: userId
    });
    return {};
}

/**
 * Put a user on exactly one role. The directory offers a single role per person
 * because that is how invites hand them out; a bespoke set of several is a
 * policy attachment, which lives on its own page.
 */
export async function setUserRole(actorId: string, userId: string, roleName: string): Promise<{ error?: string }> {
    const role = await prisma.role.findUnique({ where: { name: roleName }, select: { id: true } });
    if (!role) return { error: "Unknown role." };
    await prisma.$transaction([
        prisma.userRole.deleteMany({ where: { userId } }),
        prisma.userRole.create({ data: { userId, roleId: role.id } })
    ]);
    await recordAudit({
        actorId,
        action: "user.role",
        targetType: "user",
        targetId: userId,
        metadata: { role: roleName }
    });
    return {};
}

/** Impose (or lift) the network limits on an account. */
export async function setUserLimits(
    actorId: string,
    userId: string,
    rules: AccessRulesInput
): Promise<{ error?: string }> {
    await updateEnforcedRules(userId, actorId, rules);
    // A limit that only applies to the next sign-in is not a limit: the sessions
    // already open were opened from wherever they were opened.
    await dropSessions(userId);
    await recordAudit({
        actorId,
        action: "user.limits",
        targetType: "user",
        targetId: userId,
        metadata: {
            cidrs: rules.allowedCidrs.length,
            countries: rules.allowedCountries.length,
            continents: rules.allowedContinents.length,
            groups: rules.groupIds.length
        }
    });
    return {};
}

/** Sign a user out everywhere. */
export async function revokeUserSessions(actorId: string, userId: string): Promise<{ error?: string }> {
    await dropSessions(userId);
    await recordAudit({ actorId, action: "user.sessions.revoke", targetType: "user", targetId: userId });
    return {};
}

/**
 * Delete an account and everything that hangs off it. Irreversible, and it takes
 * the user's connections, deployments and shares with it, so the caller confirms
 * first; the guards here only stop the two deletions nobody can undo their way
 * out of - your own account, and the last administrator.
 */
export async function deleteUser(actorId: string, userId: string): Promise<{ error?: string }> {
    if (userId === actorId) return { error: "You can't delete your own account." };
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!target) return { error: "User not found." };
    if (await wouldStrandInstance(userId)) return { error: "This is the last administrator." };

    await prisma.user.delete({ where: { id: userId } });
    await recordAudit({
        actorId,
        action: "user.delete",
        targetType: "user",
        targetId: userId,
        metadata: { email: target.email }
    });
    return {};
}
