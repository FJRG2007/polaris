/**
 * Alarm history for threshold triggers: one row per stretch a trigger spent in
 * alarm - when it crossed, when it came back, the worst value seen. The run a
 * crossing starts carries the episode's id as `trigger.episodeId`.
 *
 * Recording is idempotent on (automation, trigger, startedAt): a pass that dies
 * after writing and checks the same sample again finds the same row.
 */

import { prisma } from "@polaris/db";
import type * as core from "@polaris/core";
import type { Crossing, EpisodeRecorder } from "./thresholds";

/** Resolved episodes older than this are dropped. */
export const EPISODE_KEEP_DAYS = 90;
/** At most this many per automation, newest kept. */
export const EPISODE_KEEP_PER_AUTOMATION = 500;

/**
 * Open an episode on the way into alarm, keep its worst value while it lasts,
 * close it on the way back. Opening one closes any other the same trigger left
 * open: only the trigger's current memory is still in alarm.
 */
export const recordEpisode: EpisodeRecorder = async (
    trigger: { automationId: string; nodeId: string },
    config: core.ThresholdConfig,
    crossing: Crossing
) => {
    const startedAt = new Date(crossing.startedAt);
    const key = {
        automationId_nodeId_startedAt: {
            automationId: trigger.automationId,
            nodeId: trigger.nodeId,
            startedAt
        }
    };
    if (crossing.state === "alarm")
        await prisma.automationAlarmEpisode.updateMany({
            where: {
                automationId: trigger.automationId,
                nodeId: trigger.nodeId,
                resolvedAt: null,
                startedAt: { not: startedAt }
            },
            data: { resolvedAt: startedAt }
        });
    const row = await prisma.automationAlarmEpisode.upsert({
        where: key,
        create: {
            automationId: trigger.automationId,
            nodeId: trigger.nodeId,
            source: config.source,
            subjectId: config.subjectId,
            comparator: config.comparator,
            threshold: config.value,
            startedAt,
            startValue: crossing.startValue,
            peakValue: crossing.peak,
            resolvedAt: crossing.state === "ok" ? crossing.at : null,
            endValue: crossing.state === "ok" ? crossing.value : null
        },
        update:
            crossing.state === "ok"
                ? { resolvedAt: crossing.at, endValue: crossing.value, peakValue: crossing.peak }
                : { resolvedAt: null, endValue: null, peakValue: crossing.peak },
        select: { id: true }
    });
    return row.id;
};

/**
 * Close the open episodes of an automation that no armed trigger is still in:
 * a trigger removed or re-configured on publish, or the automation switched
 * off. `keep` names the ones the armed triggers' memory still holds open.
 */
export async function closeStrandedEpisodes(
    automationId: string,
    keep: readonly { nodeId: string; startedAt: string }[],
    at = new Date()
): Promise<number> {
    const open = await prisma.automationAlarmEpisode.findMany({
        where: { automationId, resolvedAt: null },
        select: { id: true, nodeId: true, startedAt: true },
        take: 1000
    });
    const stranded = open.filter(
        (row) =>
            !keep.some(
                (held) =>
                    held.nodeId === row.nodeId &&
                    Date.parse(held.startedAt) === row.startedAt.getTime()
            )
    );
    if (stranded.length === 0) return 0;
    const closed = await prisma.automationAlarmEpisode.updateMany({
        where: { id: { in: stranded.map((row) => row.id) }, resolvedAt: null },
        data: { resolvedAt: at }
    });
    return closed.count;
}

export interface EpisodeView {
    readonly id: string;
    readonly nodeId: string;
    readonly source: string;
    readonly comparator: string;
    readonly threshold: number;
    readonly startedAt: string;
    readonly startValue: number;
    readonly peakValue: number;
    readonly resolvedAt: string | null;
    readonly endValue: number | null;
    /** Null while it lasts. */
    readonly durationSeconds: number | null;
}

const EPISODE_SELECT = {
    id: true,
    nodeId: true,
    source: true,
    comparator: true,
    threshold: true,
    startedAt: true,
    startValue: true,
    peakValue: true,
    resolvedAt: true,
    endValue: true
} as const;

function toView(row: {
    id: string;
    nodeId: string;
    source: string;
    comparator: string;
    threshold: number;
    startedAt: Date;
    startValue: number;
    peakValue: number;
    resolvedAt: Date | null;
    endValue: number | null;
}): EpisodeView {
    return {
        ...row,
        startedAt: row.startedAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        durationSeconds: row.resolvedAt
            ? Math.round((row.resolvedAt.getTime() - row.startedAt.getTime()) / 1000)
            : null
    };
}

/** An automation's newest episodes. The caller has already checked it may read the automation. */
export async function listEpisodes(automationId: string, take = 50): Promise<EpisodeView[]> {
    const rows = await prisma.automationAlarmEpisode.findMany({
        where: { automationId },
        orderBy: { startedAt: "desc" },
        take: Math.min(Math.max(take, 1), 200),
        select: EPISODE_SELECT
    });
    return rows.map(toView);
}

/** One episode of this automation, or null - never another automation's, whatever id a run names. */
export async function getEpisode(
    automationId: string,
    episodeId: string | null
): Promise<EpisodeView | null> {
    if (!episodeId) return null;
    const row = await prisma.automationAlarmEpisode.findFirst({
        where: { id: episodeId, automationId },
        select: EPISODE_SELECT
    });
    return row ? toView(row) : null;
}

/**
 * Drop resolved episodes past the keep window, and the oldest beyond the
 * per-automation cap. An open episode is never dropped by age: it is the alarm
 * still going on. Bounded per pass so a backlog drains over several.
 */
export async function pruneEpisodes(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - EPISODE_KEEP_DAYS * 86_400_000);
    const aged = await prisma.automationAlarmEpisode.deleteMany({
        where: { resolvedAt: { not: null, lt: before } }
    });
    let capped = 0;
    const crowded = await prisma.automationAlarmEpisode.groupBy({
        by: ["automationId"],
        _count: { _all: true },
        having: { automationId: { _count: { gt: EPISODE_KEEP_PER_AUTOMATION } } },
        orderBy: { automationId: "asc" },
        take: 20
    });
    for (const group of crowded) {
        const extra = await prisma.automationAlarmEpisode.findMany({
            where: { automationId: group.automationId },
            orderBy: { startedAt: "desc" },
            skip: EPISODE_KEEP_PER_AUTOMATION,
            take: 1000,
            select: { id: true }
        });
        if (extra.length === 0) continue;
        const removed = await prisma.automationAlarmEpisode.deleteMany({
            where: { id: { in: extra.map((row) => row.id) } }
        });
        capped += removed.count;
    }
    return aged.count + capped;
}
