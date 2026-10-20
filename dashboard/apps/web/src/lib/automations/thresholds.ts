/**
 * "When a reading crosses a threshold": the polled trigger.
 *
 * Each armed `core.threshold` row is due once a sampling interval. Its memory
 * (ok or alarm, the breach streak, the last sample counted, the open episode)
 * lives on the trigger row's `state`; the ok/alarm rule itself is
 * `stepAlarm`, the one Watch's alarms use.
 *
 * A run starts on the transition into alarm, and on the way back only when
 * the trigger asks for it - never on every sample. Prior art: Prometheus's
 * `for:` (pending -> firing, resolved when the condition clears), Home
 * Assistant's numeric_state trigger with `for`, and Grafana's alert state
 * machine (Normal -> Pending -> Alerting -> Normal). Missing data holds the
 * state where it is (Grafana's "keep last state") rather than resolving an
 * alarm nobody can see.
 *
 * Exactly once: the firing key is the trigger and the sample that crossed, so
 * a pass that dies after starting the run and before saving the memory
 * re-derives the same transition from the same sample, and the run is not
 * started twice.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { fireTrigger } from "./combine";
import { automationRunner } from "./runner";
import { loadGraph, type StartedRun } from "./engine";
import { compare, stepAlarm, worse } from "@/lib/alarm-state";
import type { MetricReading } from "@/lib/watch/metric-reading";

/**
 * The lease (`withLease`, lib/cron/lease.ts) the threshold pass runs under: one
 * process at a time, expiring on its own when the holder dies. Each row's due
 * time is compare-and-swapped as well, so even a pass that outlived its lease
 * reads a row once.
 */
export const THRESHOLD_LEASE = "automations.thresholds";

/** How often a threshold is read: the sampling interval of what it reads. */
export const THRESHOLD_POLL_MS = Number(process.env.POLARIS_THRESHOLD_POLL_MS) || 60_000;

export interface OpenEpisode {
    /** When the sample that crossed was taken. */
    readonly startedAt: string;
    readonly startValue: number;
    /** The worst value seen while in alarm: the highest above, the lowest below. */
    readonly peak: number;
}

export interface ThresholdMemory {
    /** The config it was armed with: a changed one starts over. */
    readonly config: string;
    readonly state: "ok" | "alarm";
    readonly streak: number;
    /** The last sample counted, so one sample never counts twice. */
    readonly sampledAt: string | null;
    readonly value: number | null;
    /** Why there was no reading on the last check, or null. */
    readonly missing: string | null;
    readonly checkedAt: string | null;
    readonly episode: OpenEpisode | null;
}

/** The memory on a trigger row, or a fresh one when it was armed with another config. */
export function readMemory(state: unknown, config: string): ThresholdMemory {
    const stored = (state ?? {}) as Partial<ThresholdMemory>;
    if (stored.config !== config || (stored.state !== "ok" && stored.state !== "alarm"))
        return {
            config,
            state: "ok",
            streak: 0,
            sampledAt: null,
            value: null,
            missing: null,
            checkedAt: null,
            episode: null
        };
    return {
        config,
        state: stored.state,
        streak: typeof stored.streak === "number" ? stored.streak : 0,
        sampledAt: stored.sampledAt ?? null,
        value: typeof stored.value === "number" ? stored.value : null,
        missing: stored.missing ?? null,
        checkedAt: stored.checkedAt ?? null,
        episode: stored.episode ?? null
    };
}

export interface Crossing {
    readonly state: "alarm" | "ok";
    readonly at: Date;
    readonly value: number;
    readonly startedAt: string;
    readonly startValue: number;
    readonly peak: number;
    /** On recovery: how long the alarm lasted. */
    readonly durationSeconds: number | null;
}

export interface Judgement {
    readonly memory: ThresholdMemory;
    /** The transition this sample made, whether or not the trigger fires on it. */
    readonly crossing: Crossing | null;
}

/** One check of a threshold. Pure. */
export function judge(
    memory: ThresholdMemory,
    config: core.ThresholdConfig,
    reading: MetricReading,
    now: Date
): Judgement {
    const checkedAt = now.toISOString();
    if (typeof reading === "string")
        return { memory: { ...memory, missing: reading, checkedAt }, crossing: null };
    if (memory.sampledAt && reading.at.getTime() <= Date.parse(memory.sampledAt))
        return { memory: { ...memory, missing: null, checkedAt }, crossing: null };
    const breach = compare(reading.value, config.comparator, config.value);
    const step = stepAlarm(
        { state: memory.state, streak: memory.streak },
        { breach, insufficient: false },
        config.streak
    );
    const at = reading.at.toISOString();
    const base = {
        ...memory,
        state: step.state === "alarm" ? ("alarm" as const) : ("ok" as const),
        streak: step.streak,
        sampledAt: at,
        value: reading.value,
        missing: null,
        checkedAt
    };
    if (step.transition === "triggered") {
        const episode = { startedAt: at, startValue: reading.value, peak: reading.value };
        return {
            memory: { ...base, episode },
            crossing: {
                state: "alarm",
                at: reading.at,
                value: reading.value,
                ...episode,
                durationSeconds: null
            }
        };
    }
    if (step.transition === "resolved") {
        const episode = memory.episode ?? {
            startedAt: at,
            startValue: reading.value,
            peak: reading.value
        };
        return {
            memory: { ...base, episode: null },
            crossing: {
                state: "ok",
                at: reading.at,
                value: reading.value,
                ...episode,
                durationSeconds: Math.max(
                    0,
                    Math.round((reading.at.getTime() - Date.parse(episode.startedAt)) / 1000)
                )
            }
        };
    }
    const episode =
        base.state === "alarm" && memory.episode
            ? {
                  ...memory.episode,
                  peak: worse(config.comparator, memory.episode.peak, reading.value)
              }
            : memory.episode;
    return { memory: { ...base, episode }, crossing: null };
}

/** What the run reads as `trigger.*`. */
export function crossingCause(
    nodeId: string,
    config: core.ThresholdConfig,
    crossing: Crossing,
    episodeId: string | null
): Record<string, unknown> {
    return {
        id: nodeId,
        at: crossing.at.toISOString(),
        kind: "threshold",
        state: crossing.state,
        value: crossing.value,
        threshold: config.value,
        comparator: config.comparator,
        source: config.source,
        subjectId: config.subjectId,
        episodeId,
        startedAt: crossing.startedAt,
        durationSeconds: crossing.durationSeconds,
        peak: crossing.peak
    };
}

/** Recorded in an episode's history; part 3's store. Null when none is kept. */
export type EpisodeRecorder = (
    trigger: { automationId: string; nodeId: string },
    config: core.ThresholdConfig,
    crossing: Crossing
) => Promise<string | null>;

const noRecorder: EpisodeRecorder = async () => null;

/**
 * Check every threshold that is due. Each row's due time is moved on by
 * compare-and-swap before it is read, so a second process that reaches the
 * same row in the same instant reads nothing.
 */
export async function evaluateThresholds(
    limit = 100,
    record: EpisodeRecorder = noRecorder
): Promise<StartedRun[]> {
    const now = new Date();
    const due = await prisma.automationTrigger.findMany({
        // A switched-off automation is disarmed, so every row here is live.
        where: { eventType: "core.threshold", nextDueAt: { lte: now } },
        orderBy: { nextDueAt: "asc" },
        take: limit,
        select: {
            id: true,
            automationId: true,
            versionId: true,
            nodeId: true,
            nextDueAt: true,
            state: true,
            automation: { select: { runAsId: true, orgId: true, userId: true } }
        }
    });
    const started: StartedRun[] = [];
    for (const row of due) {
        try {
            const moved = await prisma.automationTrigger.updateMany({
                where: { id: row.id, nextDueAt: row.nextDueAt },
                data: { nextDueAt: new Date(now.getTime() + THRESHOLD_POLL_MS) }
            });
            if (moved.count !== 1) continue;
            const run = await checkOne(row, now, record);
            if (run) started.push(run);
        } catch (caught) {
            console.error("polaris: a threshold trigger failed to evaluate:", caught);
        }
    }
    return started;
}

async function checkOne(
    row: {
        id: string;
        automationId: string;
        versionId: string;
        nodeId: string;
        state: unknown;
        automation: { runAsId: string | null; orgId: string | null; userId: string | null };
    },
    now: Date,
    record: EpisodeRecorder
): Promise<StartedRun | null> {
    const graph = await loadGraph(row.versionId);
    const node = graph?.nodes.find((entry) => entry.id === row.nodeId);
    const parsed = core.thresholdConfigSchema.safeParse(node?.config);
    if (!parsed.success) return null;
    const config = parsed.data;
    const memory = readMemory(row.state, JSON.stringify(node?.config ?? {}));
    // Loaded here, not at the top: the registry reaches Watch, servers and UPS
    // code that the rest of the automations pass never needs.
    const { thresholdSource } = await import("./threshold-sources");
    const provided = thresholdSource(config.source);
    const actor = await automationRunner(row.automation);
    let reading: MetricReading;
    if (!provided) reading = "source unavailable";
    else if (!actor || !(await provided.kind.mayRead(actor, config.subjectId)))
        reading = "subject not available";
    else reading = await provided.source.read(config.subjectId, now.getTime());
    const { memory: next, crossing } = judge(memory, config, reading, now);
    let run: StartedRun | null = null;
    if (crossing) {
        const episodeId = await record(row, config, crossing);
        if (crossing.state === "alarm" || config.recovery)
            run = await fireTrigger({
                automationId: row.automationId,
                versionId: row.versionId,
                triggerNodeId: row.nodeId,
                firingKey: `${row.nodeId}:${crossing.state}:${crossing.at.toISOString()}`,
                cause: crossingCause(row.nodeId, config, crossing, episodeId),
                depth: 0
            });
    } else if (next.episode && memory.episode && next.episode.peak !== memory.episode.peak) {
        const worsened: Crossing = {
            state: "alarm",
            at: next.sampledAt ? new Date(next.sampledAt) : now,
            value: next.value ?? next.episode.peak,
            ...next.episode,
            durationSeconds: null
        };
        await record(row, config, worsened).catch((caught) =>
            console.error("polaris: an alarm episode's worst value failed to save:", caught)
        );
    }
    await prisma.automationTrigger.updateMany({
        where: { id: row.id },
        data: { state: next as object }
    });
    return run;
}
