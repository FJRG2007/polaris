/**
 * The analytics background loop.
 *
 * Two jobs on two clocks. Folding the edge log into visits has to be frequent, or
 * the "who is on the site right now" panel is a panel about five minutes ago;
 * rolling a finished day into totals and dropping raw rows past retention is daily
 * work that only has to happen at all.
 *
 * Separate from the firewall's sentinel even though both read the same file. They
 * answer different questions on different schedules, and one throwing must not stop
 * the other - a failed rollup should never leave an attacker unbanned.
 */

import { pruneAnalytics, ingestEdgeVisits } from "@/lib/analytics-ingest";

/** Frequent enough that the realtime panel is honest about what it shows. */
const TICK_MS = 30_000;

/** Ticks between the housekeeping pass. Hourly: the work is per-day, and running it
 *  more often than that only re-reads days it already folded. */
const MAINTENANCE_EVERY_TICKS = 120;

let started = false;

export function startAnalyticsCollector(): void {
    if (started) return;
    started = true;
    let ticks = 0;

    const tick = async () => {
        try {
            await ingestEdgeVisits();
            if (ticks % MAINTENANCE_EVERY_TICKS === 0) await pruneAnalytics();
        } catch (error) {
            console.error("polaris: the analytics collector tick failed:", error);
        } finally {
            ticks += 1;
        }
    };

    const timer = setInterval(() => void tick(), TICK_MS);
    // Never hold the process open for this.
    timer.unref?.();
    void tick();
}
