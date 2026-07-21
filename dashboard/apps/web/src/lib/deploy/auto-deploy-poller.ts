/**
 * Vercel-style auto-deploy without a public webhook. GitHub App webhooks cannot
 * reach a LAN install, so this polls the connected repos on an interval: for each
 * application with auto-deploy on, it reads the latest commit on the tracked
 * branch and deploys when the SHA changes (and the commit-message filter passes).
 * Deduped per repo+branch so many services on one repo cost a single API call.
 */

import { prisma } from "@polaris/db";
import { getLatestCommit } from "../github-service";
import { commitPassesFilter, deployApplication } from "../deploy-service";

const INTERVAL_MS = Number(process.env.POLARIS_AUTODEPLOY_POLL_MS) || 60_000;
let started = false;

/** Extract owner/repo from a GitHub URL (https or scp-like, with or without .git). */
function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
    const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    return match ? { owner: match[1]!, repo: match[2]! } : null;
}

/** One poll pass: deploy every auto-deploy app whose branch head has advanced. */
export async function pollAutoDeploys(): Promise<void> {
    const apps = await prisma.application.findMany({
        where: { autoDeploy: true, sourceType: { in: ["dockerfile", "nixpacks"] } },
        include: { environment: { include: { project: true } } }
    });
    const commitCache = new Map<string, Awaited<ReturnType<typeof getLatestCommit>>>();

    for (const app of apps) {
        let source: Record<string, unknown>;
        try {
            source = JSON.parse(app.sourceConfig);
        } catch {
            continue;
        }
        const repoUrl = typeof source.repoUrl === "string" ? source.repoUrl : "";
        const parsed = parseOwnerRepo(repoUrl);
        if (!parsed) continue;
        const branch = (app.deployBranch?.trim() || (typeof source.branch === "string" ? source.branch : "")).trim();
        if (!branch) continue;

        const key = `${parsed.owner}/${parsed.repo}@${branch}`.toLowerCase();
        let latest = commitCache.get(key);
        if (latest === undefined) {
            latest = await getLatestCommit(parsed.owner, parsed.repo, branch);
            commitCache.set(key, latest);
        }
        if (!latest || latest.sha === app.lastDeployedSha) continue;

        // First sighting: baseline to the current head without deploying, so only a
        // genuinely new commit triggers a deploy (never a redeploy just for enabling).
        if (app.lastDeployedSha == null) {
            await prisma.application.update({ where: { id: app.id }, data: { lastDeployedSha: latest.sha } });
            continue;
        }
        if (!commitPassesFilter(latest.message, app.commitFilter)) continue;

        const ownerId = app.environment.project.ownerId;
        try {
            await deployApplication(app.id, ownerId, ownerId, {
                commitMessage: latest.message,
                commitSha: latest.sha,
                authorName: latest.authorName ?? undefined,
                authorAvatarUrl: latest.authorAvatarUrl ?? undefined
            });
            await prisma.application.update({ where: { id: app.id }, data: { lastDeployedSha: latest.sha } });
        } catch {
            // Leave lastDeployedSha unchanged so the next tick retries this commit.
        }
    }
}

/** Start the background poll loop (idempotent). Self-guarding: a failed tick only
 *  logs; the timer is unref'd so it never keeps the process alive on its own. */
export function startAutoDeployPoller(): void {
    if (started) return;
    started = true;
    const tick = (): void => void pollAutoDeploys().catch((error) => console.error("polaris: auto-deploy poll failed:", error));
    setInterval(tick, INTERVAL_MS).unref?.();
    // First pass shortly after boot, once the server has settled.
    setTimeout(tick, 15_000).unref?.();
}
