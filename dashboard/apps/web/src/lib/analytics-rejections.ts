/**
 * Beats a site's tracker sent that were turned away, counted per day and cause,
 * so the site's own screen can answer "why is nothing showing up" without a
 * log. Only causes that are known once the site is: an unknown key is never
 * counted anywhere, since this must not become a way to learn which keys exist.
 */

import { prisma } from "@polaris/db";
import { visitDay } from "@polaris/core";

export const REJECTION_CAUSES = ["off", "dnt", "bot", "path", "ip", "failed"] as const;
export type RejectionCause = (typeof REJECTION_CAUSES)[number];

/** Days of counts kept and shown. */
export const REJECTION_DAYS = 30;

/**
 * Count one turned-away beat. Never throws and never holds the beat up: a
 * failure here loses a diagnostic count, not a visit, and is not worth the
 * page's time.
 */
export function recordRejection(siteId: string, cause: RejectionCause, at = Date.now()): void {
    const day = new Date(visitDay(at));
    try {
        void prisma.analyticsRejection
            .upsert({
                where: { siteId_day_cause: { siteId, day, cause } },
                create: { siteId, day, cause, count: 1 },
                update: { count: { increment: 1 } }
            })
            .catch(() => undefined);
    } catch {
        // A client that cannot even start the write loses the count, as above.
    }
}

export interface RejectionSummary {
    readonly cause: RejectionCause;
    readonly count: number;
    /** The latest day with one, UTC midnight in epoch ms. */
    readonly lastDay: number;
}

/** The last `REJECTION_DAYS` days of counts, the most frequent cause first. */
export async function rejectionSummary(siteId: string, now = Date.now()): Promise<RejectionSummary[]> {
    const rows = await prisma.analyticsRejection.groupBy({
        by: ["cause"],
        where: { siteId, day: { gte: new Date(visitDay(now) - (REJECTION_DAYS - 1) * 86_400_000) } },
        _sum: { count: true },
        _max: { day: true }
    });
    return rows
        .filter((row): row is typeof row & { cause: RejectionCause } => (REJECTION_CAUSES as readonly string[]).includes(row.cause))
        .map((row) => ({ cause: row.cause, count: row._sum.count ?? 0, lastDay: row._max.day?.getTime() ?? 0 }))
        .filter((row) => row.count > 0)
        .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
}

/** Drop counts older than the window; run with the daily prune. */
export async function pruneRejections(now = Date.now()): Promise<number> {
    const removed = await prisma.analyticsRejection.deleteMany({
        where: { day: { lt: new Date(visitDay(now) - REJECTION_DAYS * 86_400_000) } }
    });
    return removed.count;
}
