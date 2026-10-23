/**
 * The one way a pushed commit becomes a deploy, whoever noticed it: the webhook,
 * the poller, or a wait for CI that just turned green.
 */

import { prisma } from "@polaris/db";
import { deployApplication } from "../deploy-service";

/**
 * Deploy a pushed commit on a service, unless something already took it.
 *
 * A push reaches a service two ways - the webhook, and the poller for installs
 * GitHub cannot reach - and a webhook can be delivered twice. Each used to read
 * the last deployed commit, start a deploy and only then record the new one, so
 * two of them landing together each started a deploy of the same commit, and
 * the second died on the first's container name ("Conflict. The container name
 * ... is already in use"), seen on a live server on 2026-09-11. The commit is
 * now claimed first, in one conditional write only one caller can win; a deploy
 * that could not start hands it back so the next poll retries it.
 *
 * Answers whether this call started the deploy.
 */
export async function deployPushedCommit(
    app: { readonly id: string; readonly lastDeployedSha: string | null },
    ownerId: string,
    commit: {
        commitSha: string;
        commitMessage: string;
        authorName?: string;
        authorAvatarUrl?: string;
    }
): Promise<boolean> {
    const claimed = await prisma.application.updateMany({
        where: {
            id: app.id,
            OR: [{ lastDeployedSha: null }, { lastDeployedSha: { not: commit.commitSha } }]
        },
        data: { lastDeployedSha: commit.commitSha }
    });
    if (claimed.count === 0) return false;
    try {
        await deployApplication(app.id, ownerId, null, { ...commit, trigger: "push" });
        return true;
    } catch (error) {
        await prisma.application.updateMany({
            where: { id: app.id, lastDeployedSha: commit.commitSha },
            data: { lastDeployedSha: app.lastDeployedSha }
        });
        throw error;
    }
}
