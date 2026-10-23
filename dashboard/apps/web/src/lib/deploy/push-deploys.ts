/**
 * What a push to a repository does to the services built from it.
 *
 * A push arrives two ways - GitHub's webhook, and the poller for installs GitHub
 * cannot reach - and both end in `deployPushedCommit`, which is what makes one
 * push one deploy whichever of them gets there first.
 */

import { prisma } from "@polaris/db";
import { trackedBranch } from "./branches";
import { deployOrHold } from "./ci-wait";
import { parseWatchPaths, shouldDeployForPaths } from "@polaris/deploy";

// Where it always lived; kept importable from here for every caller that does.
export { deployPushedCommit } from "./pushed-commit";

/** "refs/heads/main" -> "main". */
export function branchFromRef(ref: string): string {
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/** Whether a commit message satisfies an auto-deploy filter. Empty = any commit;
 *  "regex:<pattern>" is matched as a regex, otherwise a case-insensitive substring
 *  (e.g. "build:" fires only on commits mentioning build: anywhere). */
export function commitPassesFilter(message: string, filter: string | null | undefined): boolean {
    const trimmed = filter?.trim();
    if (!trimmed) return true;
    if (trimmed.startsWith("regex:")) {
        try {
            return new RegExp(trimmed.slice("regex:".length)).test(message);
        } catch {
            return false;
        }
    }
    return message.toLowerCase().includes(trimmed.toLowerCase());
}

/**
 * Trigger auto-deploys for a git push: find applications tracking this repo with
 * auto-deploy enabled whose branch and commit-message filters pass, and deploy
 * each - or, for a service waiting for CI, hold the push until its checks pass.
 * Returns the number of deployments started. Not owner-scoped - a webhook
 * fans out to every matching app on the instance.
 */
export async function triggerAutoDeploysForPush(input: {
    repoFullName: string;
    branch: string;
    commitMessage: string;
    commitSha: string;
    /** Repository-relative paths the push touched, for the per-service watch paths.
     *  Empty means they could not be determined, and every matching service deploys. */
    changedPaths?: readonly string[];
}): Promise<number> {
    const apps = await prisma.application.findMany({
        where: { autoDeploy: true, sourceType: { in: ["dockerfile", "nixpacks"] } },
        include: { environment: { include: { project: true } } }
    });
    const wanted = input.repoFullName.toLowerCase();
    let started = 0;
    for (const app of apps) {
        let source: Record<string, unknown>;
        try {
            source = JSON.parse(app.sourceConfig);
        } catch {
            continue;
        }
        const repoUrl = typeof source.repoUrl === "string" ? source.repoUrl.toLowerCase() : "";
        const matchesRepo =
            repoUrl.includes(`github.com/${wanted}`) ||
            repoUrl.endsWith(`/${wanted}`) ||
            repoUrl.endsWith(`/${wanted}.git`);
        if (!matchesRepo) continue;
        const configuredBranch = trackedBranch(app, app.environment);
        if (configuredBranch && configuredBranch !== input.branch) continue;
        if (!commitPassesFilter(input.commitMessage, app.commitFilter)) continue;
        // Several services can track the same repository. Without this every one of
        // them redeploys on every push, which is what makes a monorepo unusable here.
        const watch = parseWatchPaths(app.watchPaths);
        if (!shouldDeployForPaths(input.changedPaths ?? [], watch)) {
            // Said out loud: a service that stops deploying reads as a broken webhook
            // unless something states it was a deliberate skip.
            console.info(
                `polaris: skipping auto-deploy of ${app.slug}; the push touched nothing it watches (${watch.join(", ")})`
            );
            continue;
        }
        const ownerId = app.environment.project.ownerId;
        try {
            const deployed = await deployOrHold(app, ownerId, {
                commitMessage: input.commitMessage,
                commitSha: input.commitSha,
                repoFullName: input.repoFullName,
                branch: input.branch
            });
            if (deployed) started += 1;
        } catch {
            // Skip this app; the others still deploy.
        }
    }
    return started;
}
