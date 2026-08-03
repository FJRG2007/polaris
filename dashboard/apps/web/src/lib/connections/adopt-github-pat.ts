/**
 * Hand the instance-wide GitHub token back to the person whose token it is.
 *
 * Polaris used to keep one GitHub credential for the whole deployment. Whoever
 * connected it pasted their own personal token, and every other account on the
 * box then listed, resolved and cloned repositories with it - which is the thing
 * connections exist to stop.
 *
 * So on the first boot after that changed, the token moves to its owner's own
 * connection and is cleared off the shared row. Nothing is cleared until the
 * connection has been written: if GitHub cannot be reached to confirm which
 * account the token speaks for, the row is left exactly as it was and the next
 * boot tries again, because a deployment that loses its clone credential stops
 * building.
 *
 * A GitHub App connection is left alone. An installation is a grant an
 * administrator put on a set of repositories deliberately, and it stays where it
 * is as the credential for work nobody is watching.
 */

import { prisma } from "@polaris/db";
import { readGithubAccount } from "@/lib/github-service";
import { ConnectionLimitError, listConnections, saveConnection } from "./store";
import { getIntegrationSecret, getIntegrationState, upsertIntegration } from "@/lib/integration-service";

const PROVIDER = "github";

export async function adoptInstanceGithubPat(): Promise<void> {
    const state = await getIntegrationState(PROVIDER);
    if (!state?.hasSecret || state.config.method !== "pat") return;

    const ownerId = await installerId();
    if (!ownerId) return;

    const token = await getIntegrationSecret(PROVIDER);
    if (!token) return;

    const account = await readGithubAccount(token);
    try {
        await saveConnection(ownerId, {
            provider: PROVIDER,
            accountId: String(account.id),
            label: account.login,
            avatarUrl: account.avatarUrl,
            method: "token",
            credential: { token }
        });
    } catch (caught) {
        // They have already linked as many accounts as they are allowed, which
        // means they have a personal credential and this one is spare. Anything
        // else is left for the next boot rather than guessed at.
        if (!(caught instanceof ConnectionLimitError)) throw caught;
        if ((await listConnections(ownerId, PROVIDER)).length === 0) throw caught;
    }

    // Only now: the token exists somewhere it is reachable from, so forgetting
    // the shared copy loses nothing.
    await upsertIntegration(PROVIDER, { enabled: false, config: {}, secret: null });
}

/**
 * Whoever connected the token, when they are still an account here. Rows written
 * before the installer was recorded name nobody; the token then goes to the
 * oldest administrator, which is who connected it on a deployment that has one -
 * better than stranding a working credential nothing can reach.
 */
async function installerId(): Promise<string | null> {
    const row = await prisma.integration.findUnique({
        where: { provider: PROVIDER },
        select: { installedById: true }
    });
    if (row?.installedById) {
        const exists = await prisma.user.findUnique({ where: { id: row.installedById }, select: { id: true } });
        if (exists) return exists.id;
    }
    const admin = await prisma.user.findFirst({
        where: { isAdmin: true },
        orderBy: { createdAt: "asc" },
        select: { id: true }
    });
    return admin?.id ?? null;
}
