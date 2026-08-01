/**
 * Knowing which repository is waiting for a runner.
 *
 * Without this a pool serving many repositories is guessing. It keeps runners
 * waiting somewhere, and a job queued on a repository that did not happen to get
 * one waits until a slot frees up by accident. With it, the pool moves.
 *
 * Two ways in, because one of them is not always available:
 *
 *   - GitHub's `workflow_job` webhook, which says the moment a job is queued and
 *     again when it starts and finishes. Immediate and free, and it only arrives
 *     if GitHub can reach this Polaris, which for a home network it cannot.
 *   - Asking GitHub what is queued, per repository, on a pass. Always works, costs
 *     one call per repository, and is a whole interval behind.
 *
 * They are not alternatives so much as a correction: the webhook keeps a running
 * count, and the poll periodically replaces it with the truth, so an event that
 * never arrived does not leave a repository looking permanently busy.
 *
 * Nothing here decides anything. It records what is waiting; the placement rules in
 * @polaris/core decide who that buys a runner for.
 */

import { prisma } from "@polaris/db";
import { countQueuedRuns } from "@/lib/github-runners";
import type { ResolvedTarget } from "./runner-targets";
import { parseLabels, servesLabels } from "./runner-labels";

export interface WorkflowJobEvent {
    /** queued | in_progress | completed | waiting - GitHub's own vocabulary. */
    readonly action: string;
    /** "owner/repo" the job belongs to. */
    readonly repoFullName: string;
    /** What its `runs-on` asked for. */
    readonly labels: readonly string[];
}

/**
 * Record a workflow job changing state.
 *
 * Every target that could take this job moves, not just one: two pools on two
 * machines can both serve the same repository, and both of them are entitled to
 * know there is work. The count is clamped at zero because a `completed` event can
 * arrive for a job that was queued before Polaris was listening.
 */
export async function recordWorkflowJob(event: WorkflowJobEvent): Promise<number> {
    const [owner] = event.repoFullName.split("/");
    if (!owner) return 0;

    // An organization target has no repository in its key, so both spellings are
    // asked for: a pool registered on the org serves this repository too.
    const candidates = await prisma.runnerPoolTarget.findMany({
        where: {
            OR: [{ key: event.repoFullName }, { kind: "org", owner }],
            pool: { enabled: true }
        },
        include: { pool: { select: { labels: true } } }
    });

    const delta = event.action === "queued" ? 1 : event.action === "in_progress" || event.action === "completed" ? -1 : 0;
    if (delta === 0) return 0;

    let moved = 0;
    for (const target of candidates) {
        if (!servesLabels(parseLabels(target.pool.labels), event.labels)) continue;
        await prisma.runnerPoolTarget.update({
            where: { id: target.id },
            data: { queued: Math.max(0, target.queued + delta), queuedAt: new Date() }
        });
        moved += 1;
    }
    return moved;
}

/** How stale a webhook-maintained count is allowed to get before it is replaced
 *  with what GitHub actually has. */
const DEMAND_REFRESH_MS = Number(process.env.POLARIS_RUNNER_DEMAND_MS) || 60_000;

/** Repositories asked about in one pass. A pool serving fifty of them would
 *  otherwise spend fifty calls a minute of a rate limit shared with everything
 *  else Polaris does on GitHub; the stalest are asked first, so every repository
 *  comes round, just not all at once. */
const DEMAND_REFRESH_PER_PASS = 10;

/**
 * Replace the recorded demand with what GitHub reports.
 *
 * Only worth doing when the pool has to choose: if it has a slot for every
 * repository it serves, every repository gets a runner regardless of who is
 * waiting, and a call per repository would buy nothing. That check is what keeps a
 * pool pointed at fifty repositories from spending fifty calls a minute.
 */
export async function refreshDemand(
    targets: readonly {
        id: string;
        kind: "repo" | "org";
        owner: string;
        repo: string | null;
        queuedAt: Date | null;
    }[],
    options: { needed: boolean }
): Promise<void> {
    if (!options.needed) return;
    const now = Date.now();

    const due = targets
        .filter((target) => target.kind === "repo")
        .filter((target) => !target.queuedAt || now - target.queuedAt.getTime() >= DEMAND_REFRESH_MS)
        .sort((a, b) => (a.queuedAt?.getTime() ?? 0) - (b.queuedAt?.getTime() ?? 0))
        .slice(0, DEMAND_REFRESH_PER_PASS);

    for (const target of due) {
        const queued = await countQueuedRuns({ scope: "repo", owner: target.owner, repo: target.repo ?? undefined });
        await prisma.runnerPoolTarget.update({
            where: { id: target.id },
            data: { queued, queuedAt: new Date() }
        });
    }
}

/** Note a runner having been started for a target, which is what the round-robin
 *  reads to decide who has waited longest. */
export async function markServed(targetId: string): Promise<void> {
    await prisma.runnerPoolTarget.update({ where: { id: targetId }, data: { lastServedAt: new Date() } });
}

/** Targets of a pool that a dropped scope left behind, so their runners can be
 *  stood down before the rows go. */
export function describeDropped(dropped: readonly ResolvedTarget[]): string | null {
    if (dropped.length === 0) return null;
    const names = dropped.slice(0, 3).map((target) => target.key);
    const rest = dropped.length - names.length;
    return `Stopped serving ${names.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}.`;
}
