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

/** Open an episode on the way into alarm, close it on the way back. */
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
                : {},
        select: { id: true }
    });
    return row.id;
};

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

/** An automation's newest episodes. The caller has already checked it may read the automation. */
export async function listEpisodes(automationId: string, take = 50): Promise<EpisodeView[]> {
    const rows = await prisma.automationAlarmEpisode.findMany({
        where: { automationId },
        orderBy: { startedAt: "desc" },
        take: Math.min(Math.max(take, 1), 200),
        select: {
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
        }
    });
    return rows.map((row) => ({
        ...row,
        startedAt: row.startedAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        durationSeconds: row.resolvedAt
            ? Math.round((row.resolvedAt.getTime() - row.startedAt.getTime()) / 1000)
            : null
    }));
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
