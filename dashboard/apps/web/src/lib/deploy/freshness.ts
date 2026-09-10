/**
 * Whether a service is running the head of the branch it tracks, or how many
 * commits it is behind.
 *
 * The live release is what is compared - its commit, not `lastDeployedSha`, which
 * is the auto-deploy poller's bookmark and moves when a push is skipped for its
 * watch paths. One compare call per service, cached for a minute per repository,
 * branch and commit, so a panel reopened in a loop costs GitHub nothing more.
 */

import { prisma } from "@polaris/db";
import { trackedBranch } from "./branches";
import { parseGithubRepo } from "../repo-reference";
import { githubTokenForOwner } from "../github-access";
import { compareCommits, type CommitDistance } from "../github-service";

export interface DeployFreshness {
    /** The branch the service builds from. */
    branch: string;
    /** Commits on that branch the live release does not have. */
    behindBy: number;
    /** GitHub's page listing them, when it gave one. */
    compareUrl: string | null;
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; value: CommitDistance | null }>();

async function cachedCompare(
    key: string,
    load: () => Promise<CommitDistance | null>
): Promise<CommitDistance | null> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await load();
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: Date.now(), value });
    return value;
}

/**
 * How far behind its branch a service's live release is. Null when there is
 * nothing to compare: a service built from an image, one never deployed, a
 * release with no recorded commit, or a repository GitHub would not answer for.
 */
export async function deployFreshness(applicationId: string): Promise<DeployFreshness | null> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: {
            sourceType: true,
            sourceConfig: true,
            deployBranch: true,
            currentDeploymentId: true,
            environment: { select: { branch: true, project: { select: { ownerId: true } } } }
        }
    });
    if (!app || !app.currentDeploymentId) return null;
    if (app.sourceType !== "dockerfile" && app.sourceType !== "nixpacks") return null;

    const current = await prisma.deployment.findUnique({
        where: { id: app.currentDeploymentId },
        select: { commitSha: true }
    });
    if (!current?.commitSha) return null;

    let repoUrl = "";
    try {
        const source = JSON.parse(app.sourceConfig) as Record<string, unknown>;
        repoUrl = typeof source.repoUrl === "string" ? source.repoUrl : "";
    } catch {
        return null;
    }
    const repo = parseGithubRepo(repoUrl);
    const branch = trackedBranch(app, app.environment);
    if (!repo || !branch) return null;

    // Keyed by who asks as well as what: a repository one owner reaches and
    // another does not must not answer from a cache filled for the first.
    const ownerId = app.environment.project.ownerId;
    const key =
        `${ownerId}:${repo.owner}/${repo.repo}@${branch}:${current.commitSha}`.toLowerCase();
    const distance = await cachedCompare(key, async () => {
        const token = await githubTokenForOwner(ownerId, repo.owner);
        return compareCommits(repo.owner, repo.repo, current.commitSha as string, branch, token);
    });
    if (!distance) return null;
    return { branch, behindBy: distance.aheadBy, compareUrl: distance.htmlUrl };
}
