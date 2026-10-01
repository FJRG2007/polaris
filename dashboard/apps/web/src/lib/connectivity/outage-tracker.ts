/**
 * Keeping the record of connectivity outages, from the passes the address watcher
 * already makes.
 *
 * There is no prober here. `sweepAddresses` probes the public addresses and, when
 * none answers, asks the public resolvers - the same two questions behind the
 * "Polaris cannot reach the internet" alert - and hands this the verdict. What
 * this adds is memory: when it started, when it ended, what kind it was, what
 * noticed it and what came back first, so "how often does this happen, and for
 * how long" has an answer that is not somebody's recollection of the bell.
 *
 * The decisions are `nextSteps` in `outages.ts`, pure and tested. This module
 * reads what they need and writes what they decide, with every write conditional
 * on the row still being what was read: during an update two web containers
 * serve at once and both sweep, and the unique open slot plus the conditional
 * updates are what let them do it without two rows for one outage.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { getSetting, setSetting } from "@/lib/setting-store";
import { CLOSE_WATCH_MS, STALE_AFTER_MS, WATCH_INTERVAL_MS } from "./cadence";
import * as rules from "./outages";

const MERGE_GAP_KEY = "connectivity.mergeGapSeconds";
/** The last pass, so the screen can say "checked 2 minutes ago" when all is well
 *  and the next outage knows when things were last fine. */
const LAST_PASS_KEY = "connectivity.lastPass";
/** When the record began, so a period older than it is not reported as 100%. */
const SINCE_KEY = "connectivity.since";

const OPEN = "open";
const DAY_MS = 24 * 3_600_000;

/** What the last pass found, as stored under LAST_PASS_KEY. */
interface LastPass {
    readonly at: number;
    readonly up: boolean;
    /** When a pass last found everything answering. */
    readonly lastUpAt: number | null;
}

function parseLastPass(value: string | null): LastPass | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as Partial<LastPass>;
        if (typeof parsed.at !== "number" || typeof parsed.up !== "boolean") return null;
        return {
            at: parsed.at,
            up: parsed.up,
            lastUpAt: typeof parsed.lastUpAt === "number" ? parsed.lastUpAt : null
        };
    } catch {
        return null;
    }
}

export async function mergeGapSeconds(): Promise<number> {
    return rules.storedMergeGap(await getSetting(MERGE_GAP_KEY));
}

/** Write the merge gap. The caller has validated it; this stores what it was given. */
export async function setMergeGapSeconds(seconds: number): Promise<void> {
    await setSetting(MERGE_GAP_KEY, String(seconds));
}

const SNAPSHOT_SELECT = {
    id: true,
    kind: true,
    startedAt: true,
    endedAt: true,
    lastSeenAt: true,
    firstBack: true,
    closedBy: true
} as const;

function snapshot(
    row: {
        id: string;
        kind: string;
        startedAt: Date;
        endedAt: Date | null;
        lastSeenAt: Date;
        firstBack: string | null;
        closedBy: string | null;
    } | null
): rules.OutageSnapshot | null {
    if (!row) return null;
    return {
        id: row.id,
        kind: rules.isOutageKind(row.kind) ? row.kind : "address",
        startedAt: row.startedAt.getTime(),
        endedAt: row.endedAt?.getTime() ?? null,
        lastSeenAt: row.lastSeenAt.getTime(),
        firstBack: row.firstBack,
        closedBy: row.closedBy
    };
}

/** A write another container already made is not an error: it is the same write. */
async function quietly(write: () => Promise<unknown>): Promise<void> {
    try {
        await write();
    } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === "P2002") return;
        throw error;
    }
}

async function apply(step: rules.TrackerStep, open: rules.OutageSnapshot | null): Promise<void> {
    const outages = prisma.connectivityOutage;
    switch (step.do) {
        case "open":
            await quietly(() =>
                outages.create({
                    data: {
                        kind: step.kind,
                        startedAt: new Date(step.at),
                        lastSeenAt: new Date(step.at),
                        lastUpAt: step.lastUpAt === null ? null : new Date(step.lastUpAt),
                        detectedBy: step.detectedBy,
                        detail: step.detail,
                        openSlot: OPEN
                    }
                })
            );
            return;
        case "continue": {
            const backNow = open?.firstBack === null && step.firstBack !== null;
            await outages.updateMany({
                where: { id: step.id, endedAt: null },
                data: {
                    kind: step.kind,
                    lastSeenAt: new Date(step.at),
                    ...(backNow
                        ? { firstBack: step.firstBack, firstBackAt: new Date(step.at) }
                        : {})
                }
            });
            return;
        }
        case "close": {
            const backNow = open?.firstBack === null && step.firstBack !== null;
            await outages.updateMany({
                where: { id: step.id, endedAt: null },
                data: {
                    endedAt: new Date(step.at),
                    closedBy: step.closedBy,
                    openSlot: null,
                    ...(backNow
                        ? { firstBack: step.firstBack, firstBackAt: new Date(step.at) }
                        : {})
                }
            });
            return;
        }
        case "reopen":
            await quietly(() =>
                outages.updateMany({
                    where: { id: step.id, endedAt: new Date(step.endedAt) },
                    data: {
                        endedAt: null,
                        closedBy: null,
                        openSlot: OPEN,
                        kind: step.kind,
                        lastSeenAt: new Date(step.at),
                        firstBack: null,
                        firstBackAt: null,
                        blips: { increment: 1 }
                    }
                })
            );
            return;
    }
}

/** What a pass did, for the watcher to set its next tick by. */
export interface PassOutcome {
    /** Look again at the close pace rather than the usual one. */
    readonly closely: boolean;
}

/**
 * Record one pass of the address watcher.
 *
 * Never the reason a pass fails: the watcher calls this after it has probed and
 * alerted, and a database hiccup here costs one pass of history, not an alert.
 */
export async function recordPass(
    observation: rules.Observation,
    now = Date.now()
): Promise<PassOutcome> {
    const [openRow, lastRow, lastPassValue, gapSeconds] = await Promise.all([
        prisma.connectivityOutage.findUnique({
            where: { openSlot: OPEN },
            select: SNAPSHOT_SELECT
        }),
        prisma.connectivityOutage.findFirst({
            where: { endedAt: { not: null } },
            orderBy: { endedAt: "desc" },
            select: SNAPSHOT_SELECT
        }),
        getSetting(LAST_PASS_KEY),
        mergeGapSeconds()
    ]);
    const open = snapshot(openRow);
    const last = snapshot(lastRow);
    const lastPass = parseLastPass(lastPassValue);
    const mergeGapMs = gapSeconds * 1000;

    const steps = rules.nextSteps({
        open,
        last,
        observation,
        now,
        mergeGapMs,
        staleMs: STALE_AFTER_MS,
        lastUpAt: lastPass?.lastUpAt ?? null
    });
    for (const step of steps) await apply(step, open);

    const pass: LastPass = {
        at: now,
        up: observation.up,
        lastUpAt: observation.up ? now : (lastPass?.lastUpAt ?? null)
    };
    await setSetting(LAST_PASS_KEY, JSON.stringify(pass));
    if ((await getSetting(SINCE_KEY)) === null) await setSetting(SINCE_KEY, String(now));

    if (!observation.up) return { closely: true };
    const closed = steps.find((step) => step.do === "close" && step.closedBy === "recovered");
    const settling = closed ? { endedAt: now, closedBy: "recovered" as const } : last;
    return { closely: rules.watchClosely(null, settling, now, mergeGapMs) };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/** One outage as the screen gets it. */
export interface OutageView {
    readonly id: string;
    readonly kind: rules.OutageKind;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly lastSeenAt: string;
    readonly lastUpAt: string | null;
    readonly detectedBy: string | null;
    readonly detail: string | null;
    readonly firstBack: string | null;
    readonly firstBackAt: string | null;
    readonly closedBy: string | null;
    readonly blips: number;
}

export const PERIODS = [
    { key: "24h", ms: DAY_MS },
    { key: "7d", ms: 7 * DAY_MS },
    { key: "30d", ms: 30 * DAY_MS },
    { key: "90d", ms: 90 * DAY_MS }
] as const;

export type PeriodKey = (typeof PERIODS)[number]["key"];

export interface MonthRollup {
    readonly month: string;
    readonly kind: rules.OutageKind;
    readonly count: number;
    readonly downtimeSeconds: number;
    readonly longestSeconds: number;
}

export interface ConnectivityReport {
    readonly now: string;
    /** The last pass, or null when the watcher has never run. */
    readonly lastPass: { readonly at: string; readonly up: boolean } | null;
    /** The ongoing outage, if there is one. */
    readonly open: OutageView | null;
    /** When the record began. */
    readonly since: string | null;
    readonly periods: readonly ({ readonly key: PeriodKey } & rules.PeriodSummary)[];
    /** The last year, newest first. */
    readonly outages: readonly OutageView[];
    /** More than `outages` holds happened in the year; the oldest were left out. */
    readonly truncated: boolean;
    /** What is left of the years before, one row per month and kind. */
    readonly months: readonly MonthRollup[];
    readonly mergeGapSeconds: number;
    readonly watchIntervalMs: number;
    readonly closeWatchMs: number;
    readonly staleAfterMs: number;
}

/** The most rows the screen is sent. A year of a line that drops eight times a
 *  day, which is past where the list is what anybody is reading. */
const LIST_LIMIT = 3000;

function view(row: {
    id: string;
    kind: string;
    startedAt: Date;
    endedAt: Date | null;
    lastSeenAt: Date;
    lastUpAt: Date | null;
    detectedBy: string | null;
    detail: string | null;
    firstBack: string | null;
    firstBackAt: Date | null;
    closedBy: string | null;
    blips: number;
}): OutageView {
    return {
        id: row.id,
        kind: rules.isOutageKind(row.kind) ? row.kind : "address",
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
        lastSeenAt: row.lastSeenAt.toISOString(),
        lastUpAt: row.lastUpAt?.toISOString() ?? null,
        detectedBy: row.detectedBy,
        detail: row.detail,
        firstBack: row.firstBack,
        firstBackAt: row.firstBackAt?.toISOString() ?? null,
        closedBy: row.closedBy,
        blips: row.blips
    };
}

/** Everything the Connectivity screen shows, in one read. */
export async function connectivityReport(now = Date.now()): Promise<ConnectivityReport> {
    const yearAgo = new Date(now - rules.OUTAGE_RETENTION_DAYS * DAY_MS);
    const [rows, months, lastPassValue, sinceValue, gapSeconds] = await Promise.all([
        prisma.connectivityOutage.findMany({
            where: { OR: [{ endedAt: null }, { endedAt: { gte: yearAgo } }] },
            orderBy: { startedAt: "desc" },
            take: LIST_LIMIT + 1,
            select: {
                ...SNAPSHOT_SELECT,
                lastUpAt: true,
                detectedBy: true,
                detail: true,
                firstBackAt: true,
                blips: true
            }
        }),
        prisma.connectivityOutageMonth.findMany({
            orderBy: [{ month: "desc" }, { kind: "asc" }],
            take: 240,
            select: {
                month: true,
                kind: true,
                count: true,
                downtimeSeconds: true,
                longestSeconds: true
            }
        }),
        getSetting(LAST_PASS_KEY),
        getSetting(SINCE_KEY),
        mergeGapSeconds()
    ]);
    const outages = rows.slice(0, LIST_LIMIT).map(view);
    const spans = outages.map((outage) => ({
        startedAt: Date.parse(outage.startedAt),
        endedAt: outage.endedAt === null ? null : Date.parse(outage.endedAt),
        lastSeenAt: Date.parse(outage.lastSeenAt)
    }));
    const since = Number(sinceValue);
    const sinceAt = sinceValue !== null && Number.isFinite(since) ? since : null;
    const lastPass = parseLastPass(lastPassValue);
    return {
        now: new Date(now).toISOString(),
        lastPass: lastPass ? { at: new Date(lastPass.at).toISOString(), up: lastPass.up } : null,
        open: outages.find((outage) => outage.endedAt === null) ?? null,
        since: sinceAt === null ? null : new Date(sinceAt).toISOString(),
        periods: PERIODS.map((period) => ({
            key: period.key,
            ...rules.summarizePeriod(spans, now, period.ms, sinceAt, STALE_AFTER_MS)
        })),
        outages,
        truncated: rows.length > LIST_LIMIT,
        months: months.map((month) => ({
            ...month,
            kind: rules.isOutageKind(month.kind) ? month.kind : "address"
        })),
        mergeGapSeconds: gapSeconds,
        watchIntervalMs: WATCH_INTERVAL_MS,
        closeWatchMs: CLOSE_WATCH_MS,
        staleAfterMs: STALE_AFTER_MS
    };
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                   */
/* -------------------------------------------------------------------------- */

/** Rows folded per pass. Bounded so the first pass on a long history is quick;
 *  the next pass takes the next batch. */
const COMPACT_BATCH = 500;

/**
 * Fold outages older than the retention window into one row per month and kind,
 * then delete them - in one transaction, so a pass that dies halfway counts
 * nothing twice and loses nothing. The delete goes first and has to take every
 * row it was given: if another runner got some of them, this one rolls back
 * rather than counting rows it did not remove.
 */
export async function compactOutages(now = Date.now()): Promise<number> {
    const cutoff = new Date(now - rules.OUTAGE_RETENTION_DAYS * DAY_MS);
    const rows = await prisma.connectivityOutage.findMany({
        where: { endedAt: { not: null, lt: cutoff } },
        orderBy: { endedAt: "asc" },
        take: COMPACT_BATCH,
        select: { id: true, kind: true, startedAt: true, endedAt: true }
    });
    if (rows.length === 0) return 0;

    const totals = new Map<
        string,
        { month: string; kind: string; count: number; down: number; longest: number }
    >();
    for (const row of rows) {
        const seconds = Math.max(
            0,
            Math.round(((row.endedAt?.getTime() ?? 0) - row.startedAt.getTime()) / 1000)
        );
        const month = rules.monthOf(row.startedAt.getTime());
        const kind = rules.isOutageKind(row.kind) ? row.kind : "address";
        const key = `${month} ${kind}`;
        const total = totals.get(key) ?? { month, kind, count: 0, down: 0, longest: 0 };
        total.count += 1;
        total.down += seconds;
        total.longest = Math.max(total.longest, seconds);
        totals.set(key, total);
    }

    await prisma.$transaction(async (tx) => {
        const removed = await tx.connectivityOutage.deleteMany({
            where: { id: { in: rows.map((row) => row.id) } }
        });
        if (removed.count !== rows.length)
            throw new Error("outage rows were compacted concurrently");
        for (const total of totals.values()) {
            const existing = await tx.connectivityOutageMonth.findUnique({
                where: { month_kind: { month: total.month, kind: total.kind } },
                select: { longestSeconds: true }
            });
            if (existing) {
                await tx.connectivityOutageMonth.update({
                    where: { month_kind: { month: total.month, kind: total.kind } },
                    data: {
                        count: { increment: total.count },
                        downtimeSeconds: { increment: total.down },
                        longestSeconds: Math.max(existing.longestSeconds, total.longest)
                    }
                });
            } else {
                await tx.connectivityOutageMonth.create({
                    data: {
                        month: total.month,
                        kind: total.kind,
                        count: total.count,
                        downtimeSeconds: total.down,
                        longestSeconds: total.longest
                    }
                });
            }
        }
    });
    return rows.length;
}
