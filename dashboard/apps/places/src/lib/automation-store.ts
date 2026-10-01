/**
 * The automation engine's rows, in the database.
 *
 * Everything the engine decides is decided in `automation-engine.ts`; this is
 * only where it reads and writes. Two statements here carry the engine's
 * guarantees and are worth reading twice: `createRun` leans on the unique key of
 * (automation, firing) so one firing is one run, and `claimDueRuns` /
 * `swapObservation` are compare-and-set updates, so two runners never take the
 * same run and two syncs never fire the same change.
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma, type Prisma } from "@polaris/db";
import * as auto from "./automation-kinds";
import type {
    AutomationRecord,
    AutomationStore,
    Figure,
    Observation,
    RunRecord
} from "./automation-engine";

/** Where a purifier's most worn filter is kept among its figures. Not a measure
 *  name, so it can never be taken for one. */
const FILTER_KEY = "@filter";

const storedFigure = z.object({ value: z.string().max(200), since: z.string().datetime() });

/** The figures column, read back: each figure with when it changed, and the
 *  filter's state among them. Anything unreadable is left out. */
function figuresOf(
    stored: Prisma.JsonValue
): Pick<Observation, "figures" | "filter" | "filterSince"> {
    const parsed = z.record(z.string(), z.unknown()).safeParse(stored);
    if (!parsed.success) return {};
    const figures: Record<string, Figure> = {};
    let filter: Figure | undefined;
    for (const [key, value] of Object.entries(parsed.data)) {
        const read = storedFigure.safeParse(value);
        if (!read.success) continue;
        const figure = { value: read.data.value, since: new Date(read.data.since) };
        if (key === FILTER_KEY) filter = figure;
        else figures[key] = figure;
    }
    return {
        ...(Object.keys(figures).length > 0 ? { figures } : {}),
        ...(filter ? { filter: filter.value, filterSince: filter.since } : {})
    };
}

/** An observation as the row takes it: its figures folded into one column. */
function rowOf(observation: Observation) {
    const { figures, filter, filterSince, ...rest } = observation;
    const stored: Record<string, { value: string; since: string }> = {};
    for (const [key, figure] of Object.entries(figures ?? {})) {
        stored[key] = { value: figure.value, since: figure.since.toISOString() };
    }
    if (filter)
        stored[FILTER_KEY] = { value: filter, since: (filterSince ?? new Date()).toISOString() };
    return { ...rest, figures: stored as Prisma.InputJsonValue };
}

const RUN_FIELDS = {
    id: true,
    automationId: true,
    firingKey: true,
    cause: true,
    depth: true,
    status: true,
    step: true,
    dueAt: true,
    waitUntil: true,
    waitDeviceId: true,
    lockedUntil: true,
    steps: true,
    reason: true,
    startedAt: true,
    finishedAt: true
} as const;

const AUTOMATION_FIELDS = {
    id: true,
    installedAppId: true,
    placeId: true,
    ownerId: true,
    name: true,
    enabled: true,
    definition: true,
    armedAt: true
} as const;

type RunRow = {
    id: string;
    automationId: string;
    firingKey: string;
    cause: unknown;
    depth: number;
    status: string;
    step: number;
    dueAt: Date | null;
    waitUntil: Date | null;
    waitDeviceId: string | null;
    lockedUntil: Date | null;
    steps: unknown;
    reason: string | null;
    startedAt: Date;
    finishedAt: Date | null;
};

export function toRun(row: RunRow): RunRecord {
    return {
        ...row,
        cause: (row.cause ?? { kind: "manual", at: row.startedAt.toISOString() }) as auto.RunCause,
        status: auto.runStatus(row.status) ?? "failed",
        steps: Array.isArray(row.steps) ? (row.steps as auto.StepLog[]) : []
    };
}

/**
 * One automation as the engine reads it, or null when what is stored no longer
 * passes the schema - written by a newer build, say. It is not run: guessing
 * what a half-understood automation meant is how a door opens at the wrong hour.
 */
export function toAutomation(row: {
    id: string;
    installedAppId: string;
    placeId: string;
    ownerId: string;
    name: string;
    enabled: boolean;
    definition: unknown;
    armedAt: Date;
}): AutomationRecord | null {
    const parsed = auto.definitionSchema.safeParse(row.definition);
    if (!parsed.success) {
        console.error(`places: automation ${row.id} is stored in a shape this build cannot read`);
        return null;
    }
    return { ...row, definition: parsed.data };
}

/** A value already shaped by the schema, as the JSON column takes it. */
export function json(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

/** Whether a failure was the unique key refusing a second row. */
function duplicate(error: unknown): boolean {
    return (error as { code?: string } | null)?.code === "P2002";
}

/** The statuses that did not actually run anything, and so do not count
 *  towards how often an automation has run. */
const DID_NOT_RUN = ["skipped", "limited"];

/** The statuses a run is still going in. */
const LIVE = ["queued", "waiting", "running"];

export const prismaAutomationStore: AutomationStore = {
    async enabledAutomations(installedAppId) {
        const rows = await prisma.placeAutomation.findMany({
            where: { installedAppId, enabled: true },
            select: AUTOMATION_FIELDS
        });
        return rows.flatMap((row) => toAutomation(row) ?? []);
    },

    async automation(id) {
        const row = await prisma.placeAutomation.findUnique({
            where: { id },
            select: AUTOMATION_FIELDS
        });
        return row ? toAutomation(row) : null;
    },

    async createRun(input) {
        try {
            const row = await prisma.placeAutomationRun.create({
                data: {
                    automationId: input.automationId,
                    firingKey: input.firingKey,
                    cause: json(input.cause),
                    depth: input.depth,
                    status: input.status,
                    dueAt: input.dueAt,
                    startedAt: input.startedAt,
                    steps: json(input.steps ?? []),
                    reason: input.reason ?? null,
                    finishedAt: input.finishedAt ?? null
                },
                select: RUN_FIELDS
            });
            return toRun(row);
        } catch (error) {
            if (duplicate(error)) return null;
            throw error;
        }
    },

    async countRunsSince(automationId, since) {
        return prisma.placeAutomationRun.count({
            where: { automationId, startedAt: { gte: since }, status: { notIn: DID_NOT_RUN } }
        });
    },

    async claimDueRuns(now, lockUntil, limit) {
        const free = { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] };
        const candidates = await prisma.placeAutomationRun.findMany({
            where: {
                OR: [
                    { status: { in: ["queued", "waiting"] }, dueAt: { lte: now }, ...free },
                    // A run whose runner died mid-step: its hold ran out, and the
                    // steps it saved are where the next runner starts.
                    { status: "running", lockedUntil: { lt: now } }
                ]
            },
            orderBy: { dueAt: "asc" },
            take: limit,
            select: RUN_FIELDS
        });
        const claimed: RunRecord[] = [];
        for (const row of candidates) {
            const taken = await prisma.placeAutomationRun.updateMany({
                where: {
                    id: row.id,
                    status: row.status,
                    step: row.step,
                    dueAt: row.dueAt,
                    ...free
                },
                data: { lockedUntil: lockUntil }
            });
            if (taken.count === 1) claimed.push(toRun(row));
        }
        return claimed;
    },

    async saveRun(id, patch) {
        const { cause, steps, ...rest } = patch;
        const saved = await prisma.placeAutomationRun.updateMany({
            where: { id, status: { in: LIVE } },
            data: {
                ...rest,
                ...(cause ? { cause: json(cause) } : {}),
                ...(steps ? { steps: json(steps) } : {})
            }
        });
        return saved.count === 1;
    },

    async wakeWaiting(deviceId, now) {
        await prisma.placeAutomationRun.updateMany({
            where: { waitDeviceId: deviceId, status: "waiting" },
            data: { dueAt: now }
        });
    },

    async markAutomation(id, at, status) {
        await prisma.placeAutomation.updateMany({
            where: { id },
            data: { lastRunAt: at, lastStatus: status }
        });
    },

    async observation(deviceId) {
        return prisma.placeDeviceObservation
            .findUnique({
                where: { deviceId },
                select: {
                    state: true,
                    stateSince: true,
                    door: true,
                    doorSince: true,
                    reading: true,
                    readingSince: true,
                    mode: true,
                    modeSince: true,
                    figures: true,
                    version: true
                }
            })
            .then((row) => {
                if (!row) return null;
                const { figures, ...rest } = row;
                return { ...rest, ...figuresOf(figures) };
            });
    },

    async swapObservation(deviceId, previous, next: Observation) {
        if (!previous) {
            try {
                await prisma.placeDeviceObservation.create({ data: { deviceId, ...rowOf(next) } });
                return true;
            } catch (error) {
                if (duplicate(error)) return false;
                throw error;
            }
        }
        const swapped = await prisma.placeDeviceObservation.updateMany({
            where: { deviceId, version: previous.version },
            data: rowOf(next)
        });
        return swapped.count === 1;
    },

    async pruneRuns(automationId, keep) {
        const old = await prisma.placeAutomationRun.findMany({
            where: { automationId, status: { notIn: LIVE } },
            orderBy: { startedAt: "desc" },
            skip: keep,
            take: 500,
            select: { id: true }
        });
        if (old.length === 0) return;
        await prisma.placeAutomationRun.deleteMany({
            where: { id: { in: old.map((row) => row.id) } }
        });
    }
};
