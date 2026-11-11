/**
 * Whether a pull request event starts an automatic review.
 *
 * Only events nobody asked for go through here - a pull request opened, made
 * ready, or pushed to. A person who requests a review by name or mentions the app
 * is answered whatever these settings say.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { parse as parseYaml } from "yaml";
import { githubAppInstallationToken } from "@/lib/github-service";
import { savedReviewTiers } from "@/lib/agents/agent-defaults-service";

/** The largest review file read; anything bigger is not a settings file. */
const FILE_MOST_BYTES = 64 * 1024;

/** How long GitHub gets to hand the file over before the saved settings decide. */
const FILE_TIMEOUT_MS = 5_000;

/**
 * The repository's own `.polaris/review.yaml` at `ref`, or null when there is
 * none, it cannot be read, or it is not a mapping. Never throws: a missing or
 * broken file falls back to the saved settings rather than stopping reviews.
 */
export async function readReviewFile(repoFullName: string, ref: string): Promise<core.ReviewSettings | null> {
    const [owner, name] = repoFullName.split("/");
    if (!owner || !name || !ref) return null;
    const token = await githubAppInstallationToken(owner, {
        repositories: [name],
        permissions: { contents: "read" }
    }).catch(() => null);
    if (!token) return null;
    const path = core.REVIEW_CONFIG_PATH.split("/").map(encodeURIComponent).join("/");
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path}?ref=${encodeURIComponent(ref)}`;
    try {
        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github.raw+json",
                "User-Agent": "polaris",
                "X-GitHub-Api-Version": "2022-11-28"
            },
            cache: "no-store",
            signal: AbortSignal.timeout(FILE_TIMEOUT_MS)
        });
        if (!response.ok) return null;
        const text = await response.text();
        if (text.length > FILE_MOST_BYTES) return null;
        return core.reviewSettingsFromFile(parseYaml(text, { maxAliasCount: 50 }));
    } catch {
        return null;
    }
}

/**
 * The settings in force for one pull request: the saved tiers, with the
 * repository's file laid over them when a tier says to read it.
 */
export async function reviewSettingsFor(
    repo: { ownerId: string; repoFullName: string; review: string | null },
    refs: { defaultBranch: string | null; head: string | null }
): Promise<core.ResolvedReview> {
    const tiers = await savedReviewTiers(repo.ownerId, repo);
    const saved = core.resolveReview(...tiers);
    if (saved.configSource === "saved") return saved;
    const ref = saved.configSource === "branch" ? refs.head : refs.defaultBranch;
    const file = ref ? await readReviewFile(repo.repoFullName, ref) : null;
    return file ? { ...core.resolveReview(file, ...tiers), configSource: saved.configSource } : saved;
}

/** How many times new pushes to this pull request have already been reviewed. */
export async function reviewedPushes(repoId: string, prNumber: number): Promise<number> {
    return prisma.agentRun.count({ where: { repoId, prNumber, trigger: "pr.updated" } });
}

/**
 * How many mentions this repository answered with a run in the last hour, for
 * the hourly limit. A mention answered with a session is not counted: a
 * session is somebody's to steer, and the session limits already bound it.
 */
export async function mentionsThisHour(repoId: string): Promise<number> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    return prisma.agentRun.count({ where: { repoId, trigger: "mention", createdAt: { gte: since } } });
}
