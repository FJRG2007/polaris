/**
 * Which GitHub account belongs to which Polaris account.
 *
 * This exists for one reason: a runner pool can be told to serve "these people's
 * repositories", and that sentence is only safe if the people said so themselves.
 * A login typed into a form by an administrator would let anybody point somebody
 * else's machine at a stranger's code, so nothing here writes an identity that did
 * not come back from GitHub's own authorization screen.
 *
 * The numeric id is the identity. GitHub logins can be changed, and a freed login
 * can be registered by somebody else the same day, so the login stored alongside it
 * is a label that gets refreshed rather than something to match on.
 */

import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import type { GithubAccount } from "@/lib/github-service";

export interface LinkedGithubAccount {
    userId: string;
    githubId: number;
    login: string;
    avatarUrl: string | null;
    linkedAt: string;
}

/** The GitHub account this Polaris user linked, or null. */
export async function getGithubIdentity(userId: string): Promise<LinkedGithubAccount | null> {
    const row = await prisma.githubIdentity.findUnique({ where: { userId } });
    return row ? view(row) : null;
}

/**
 * Record that this Polaris account is that GitHub account.
 *
 * A GitHub account already claimed by somebody else is refused rather than moved:
 * silently reassigning it would change which repositories a pool serves, on the
 * word of whoever authorized second.
 */
export async function linkGithubIdentity(userId: string, account: GithubAccount): Promise<LinkedGithubAccount> {
    const claimed = await prisma.githubIdentity.findUnique({ where: { githubId: account.id } });
    if (claimed && claimed.userId !== userId) {
        throw new Error(`The GitHub account ${account.login} is already linked to another Polaris account.`);
    }

    const row = await prisma.githubIdentity.upsert({
        where: { userId },
        create: { userId, githubId: account.id, login: account.login, avatarUrl: account.avatarUrl },
        update: { githubId: account.id, login: account.login, avatarUrl: account.avatarUrl, linkedAt: new Date() }
    });
    await recordAudit({
        actorId: userId,
        action: "github.identity.link",
        targetType: "user",
        targetId: userId,
        metadata: { login: account.login }
    });
    return view(row);
}

/**
 * Forget it. Any pool serving this person stops serving their repositories on its
 * next pass, which is the point: unlinking is how somebody takes their code back
 * off somebody else's machine.
 */
export async function unlinkGithubIdentity(userId: string): Promise<void> {
    const { count } = await prisma.githubIdentity.deleteMany({ where: { userId } });
    if (count === 0) return;
    await recordAudit({ actorId: userId, action: "github.identity.unlink", targetType: "user", targetId: userId });
}

/** The GitHub logins of whichever of these Polaris users have linked an account.
 *  Users who have not are simply absent - a pool serving them serves nothing of
 *  theirs until they link, and the pool card says so. */
export async function githubLoginsForUsers(userIds: readonly string[]): Promise<LinkedGithubAccount[]> {
    if (userIds.length === 0) return [];
    const rows = await prisma.githubIdentity.findMany({ where: { userId: { in: [...userIds] } } });
    return rows.map(view);
}

/** The same, for whoever is in a group right now. Membership is read at resolution
 *  time rather than frozen into the pool, so somebody removed from the group stops
 *  being served without the pool being edited. */
export async function githubLoginsForGroup(groupId: string): Promise<LinkedGithubAccount[]> {
    const rows = await prisma.githubIdentity.findMany({
        where: { user: { groups: { some: { groupId } } } }
    });
    return rows.map(view);
}

/** People who could be picked for a pool: everybody who has linked an account. */
export async function listLinkedGithubAccounts(): Promise<Array<LinkedGithubAccount & { name: string; email: string }>> {
    const rows = await prisma.githubIdentity.findMany({
        include: { user: { select: { name: true, email: true } } },
        orderBy: { login: "asc" }
    });
    return rows.map((row) => ({ ...view(row), name: row.user.name, email: row.user.email }));
}

function view(row: {
    userId: string;
    githubId: number;
    login: string;
    avatarUrl: string | null;
    linkedAt: Date;
}): LinkedGithubAccount {
    return {
        userId: row.userId,
        githubId: row.githubId,
        login: row.login,
        avatarUrl: row.avatarUrl,
        linkedAt: row.linkedAt.toISOString()
    };
}
