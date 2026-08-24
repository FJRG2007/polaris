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

import { prisma, VISIBLE_USER } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { revokeSessionsRefusedByRules } from "@/lib/session-guard";
import { parseStringList, type AccessRulesInput } from "@polaris/core";
import { notifySessionsClosed } from "@/lib/notifications/session-events";
import { markPrincipalsMoved, updateEnforcedRules, type AccessGroupView } from "@polaris/auth";

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
    /** When the ban lifts by itself, for a suspension rather than a ban. */
    bannedUntil: string | null;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
    /** Roles held directly, and the groups they belong to. */
    roles: string[];
    groups: string[];
    /** Where the most recent session was last seen. The sessions themselves are
     *  read when a record is opened, not with the directory. */
    lastSeenAt: string | null;
    lastIp: string | null;
    lastCountry: string | null;
    createdAt: string;
    /** The limits an administrator imposed, as the editor reads them back. */
    enforced: AccessRulesInput;
}

/**
 * What describing one account takes, declared once.
 *
 * The list and one person's own page read it through the same select and the
 * same mapper: a record that disagreed with the row it was opened from would be
 * two answers to one question, and the row is the one nobody re-checks.
 */
const DIRECTORY_SELECT = {
    id: true,
    name: true,
    email: true,
    username: true,
    company: true,
    isAdmin: true,
    bannedAt: true,
    banReason: true,
    bannedUntil: true,
    emailVerified: true,
    twoFactorEnabled: true,
    createdAt: true,
    roles: { select: { role: { select: { name: true } } } },
    groups: { select: { group: { select: { name: true } } } },
    accessGroupBindings: { where: { enforced: true }, select: { groupId: true } },
    security: { select: { adminCidrs: true, adminCountries: true, adminContinents: true } },
    // The freshest session tells the directory when this account was last
    // actually used, and from where.
    sessionStates: {
        orderBy: { lastSeenAt: "desc" },
        take: 1,
        select: { lastSeenAt: true, ip: true, country: true }
    }
} as const;

/** The rows the list reads, and the shape the mapper below is written against. */
function readDirectoryRows() {
    return prisma.user.findMany({ orderBy: { createdAt: "asc" }, select: DIRECTORY_SELECT });
}

type DirectoryRow = Awaited<ReturnType<typeof readDirectoryRows>>[number];

function toDirectoryUser(row: DirectoryRow): DirectoryUser {
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
        bannedUntil: row.bannedUntil?.toISOString() ?? null,
        emailVerified: row.emailVerified,
        twoFactorEnabled: row.twoFactorEnabled,
        roles: row.roles.map((entry) => entry.role.name),
        groups: row.groups.map((entry) => entry.group.name),
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
}

/** Everyone, with what the directory needs to describe them. */
export async function listUserDirectory(): Promise<DirectoryUser[]> {
    return (await readDirectoryRows()).map(toDirectoryUser);
}

/** One account, described exactly as the directory describes it. Null when there
 *  is no such person, which the page turns into a 404. */
export async function getDirectoryUser(id: string): Promise<DirectoryUser | null> {
    const row = await prisma.user.findUnique({ where: { id }, select: DIRECTORY_SELECT });
    return row ? toDirectoryUser(row) : null;
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
    const others = await prisma.user.count({
        where: { isAdmin: true, ...VISIBLE_USER, id: { not: userId } }
    });
    return others === 0;
}

/**
 * End every session a user holds, so a change to their access is immediate.
 *
 * The stamp travels with it. A service behind a Polaris login is guarded offline from a
 * signed token, so ending the sessions here left the person still being served by every
 * route they already held one for - for hours. Marking the account re-decided is what
 * reaches those guards.
 */
async function dropSessions(userId: string): Promise<number> {
    const { count } = await prisma.session.deleteMany({ where: { userId } });
    await markPrincipalsMoved([userId]);
    return count;
}

/** The longest a suspension can run before it is simply a ban. A year, so a
 *  season-long exclusion is expressible and a typo is not permanent. */
export const MAX_SUSPENSION_MINUTES = 365 * 24 * 60;

/**
 * Shut an account, for a while or for good.
 *
 * The difference is one column. `bannedAt` is what fifteen other places read to
 * decide whether somebody is banned, and it goes on meaning exactly that; a
 * suspension is the same ban plus a note of when it lifts, which the sweep below
 * acts on. Doing it the other way round - teaching every one of those places
 * about an end date - is fifteen chances to let a suspended account in.
 */
export async function banUser(
    actorId: string,
    userId: string,
    reason: string,
    /** How long it lasts. Absent, or zero, is a ban with no end. */
    minutes?: number
): Promise<{ error?: string }> {
    if (userId === actorId) return { error: "You can't ban yourself." };
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) return { error: "User not found." };
    if (await wouldStrandInstance(userId)) return { error: "This is the last administrator." };

    const length = Math.trunc(minutes ?? 0);
    if (length < 0 || length > MAX_SUSPENSION_MINUTES) return { error: "That is not a length." };
    // Both from one instant: taken separately, a suspension's length is off by
    // however long the two calls were apart, which is the sort of thing that is
    // fine until somebody is comparing the two columns.
    const now = new Date();
    const until = length > 0 ? new Date(now.getTime() + length * 60_000) : null;

    await prisma.user.update({
        where: { id: userId },
        data: { bannedAt: now, banReason: reason.trim() || null, bannedUntil: until }
    });
    // Immediate, rather than only on their next sign-in.
    await dropSessions(userId);
    await recordAudit({
        actorId,
        action: until ? "user.suspend" : "user.ban",
        targetType: "user",
        targetId: userId,
        ...(until ? { metadata: { minutes: length, until: until.toISOString() } } : {})
    });
    return {};
}

export async function unbanUser(actorId: string, userId: string): Promise<{ error?: string }> {
    await prisma.user.update({
        where: { id: userId },
        data: { bannedAt: null, banReason: null, bannedUntil: null }
    });
    await recordAudit({ actorId, action: "user.unban", targetType: "user", targetId: userId });
    return {};
}

/**
 * Let back in everybody whose suspension has run out.
 *
 * A sweep rather than a check at sign-in, because "banned" is asked in fifteen
 * places and only one of them is a sign-in: an account whose suspension expired
 * should also be findable, mentionable and invitable again, and none of those
 * would notice a date. It is idempotent and cheap - the query names the rows it
 * would change - so running it twice at once costs nothing.
 *
 * Returns how many were let back in, which is what the job line says.
 */
export async function liftExpiredSuspensions(now = new Date()): Promise<number> {
    const due = await prisma.user.findMany({
        where: { bannedAt: { not: null }, bannedUntil: { not: null, lte: now } },
        select: { id: true }
    });
    if (due.length === 0) return 0;
    await prisma.user.updateMany({
        where: { id: { in: due.map((row) => row.id) } },
        data: { bannedAt: null, banReason: null, bannedUntil: null }
    });
    for (const row of due) {
        // Nobody did this: the clock did, which is what a null actor means.
        await recordAudit({ actorId: null, action: "user.unsuspend", targetType: "user", targetId: row.id });
    }
    return due.length;
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
    // Their sessions stay: changing somebody's role is not a reason to sign them out.
    // Only what the role reaches is re-decided, and this is what carries that to the
    // guards already serving them.
    await markPrincipalsMoved([userId]);
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
    // already open were opened from wherever they were opened. But only the ones
    // the new rules actually turn away end here - restricting an account to the
    // office is not a reason to sign it out of the office.
    const ended = await revokeSessionsRefusedByRules(userId);
    // A service behind a Polaris login is guarded offline from a signed token, so
    // the new limits have to reach those guards whether or not a session ended.
    await markPrincipalsMoved([userId]);
    await recordAudit({
        actorId,
        action: "user.limits",
        targetType: "user",
        targetId: userId,
        metadata: {
            cidrs: rules.allowedCidrs.length,
            countries: rules.allowedCountries.length,
            continents: rules.allowedContinents.length,
            groups: rules.groupIds.length,
            sessionsEnded: ended
        }
    });
    return {};
}

/** Sign a user out everywhere. */
export async function revokeUserSessions(actorId: string, userId: string): Promise<{ error?: string }> {
    const count = await dropSessions(userId);
    await recordAudit({ actorId, action: "user.sessions.revoke", targetType: "user", targetId: userId });
    // Told to the account it happened to, not to the operator who did it. Being
    // signed out of everything by somebody else is the owner's news.
    await notifySessionsClosed({ userId, count, reason: "An administrator signed your account out everywhere." });
    return {};
}

/**
 * End one of somebody else's sessions and leave the rest alone. An operator who
 * can only sign an account out everywhere has to lock its owner out of the
 * machine they are working on in order to close the one they do not recognize.
 *
 * Scoped by account as well as by session, so a mismatched pair ends nothing
 * rather than ending a stranger's session.
 */
export async function revokeSessionForUser(
    actorId: string,
    userId: string,
    sessionId: string
): Promise<{ error?: string }> {
    const result = await prisma.session.deleteMany({ where: { id: sessionId, userId } });
    if (result.count === 0) return { error: "That session has already ended." };
    await recordAudit({
        actorId,
        action: "user.session.revoke",
        targetType: "session",
        targetId: sessionId,
        metadata: { userId }
    });
    await notifySessionsClosed({
        userId,
        count: result.count,
        reason: "An administrator ended one of your sessions."
    });
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
