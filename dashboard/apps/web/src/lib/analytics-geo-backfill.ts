/**
 * Give a country to the visits recorded before this server had its geo database.
 *
 * Until now a visit only had a country when the tracker reported a time zone, so
 * every site counted from the edge log alone drew an empty map. Those visits kept
 * their address, which is all the database needs, so the raw rows still within
 * retention are placed here, once, and the finished days they belong to are folded
 * again so the longer ranges agree with the short ones.
 *
 * Walked a day at a time over the `lastSeenAt` index, with the position kept in a
 * setting, so a large history is done in bounded steps across maintenance passes
 * and a restart resumes where it stopped. Only ever fills an empty country: what a
 * proxy header or the tracker already said is never overwritten.
 */

import { prisma } from "@polaris/db";
import { visitDay } from "@polaris/core";
import { rollupAnalyticsDay } from "@/lib/analytics-ingest";
import { getSetting, setSetting } from "@/lib/setting-store";
import { countryForIp, ensureGeoDatabase, geoDatabaseReady } from "@/lib/analytics-geoip";

const CURSOR_KEY = "analytics.geoBackfill";
const DAY_MS = 86_400_000;
/** Days walked per pass. */
const DAYS_PER_PASS = 7;
/** Rows read per query inside one day. */
const BATCH = 2_000;

interface Cursor {
    /** The start of the next `lastSeenAt` day to walk, epoch ms. */
    readonly next: number;
    /** When the walk began; rows seen after it were placed at ingest. */
    readonly until: number;
}

function parseCursor(raw: string | null): Cursor | null | "done" {
    if (raw === "done") return "done";
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<Cursor>;
        if (typeof value.next === "number" && typeof value.until === "number") return { next: value.next, until: value.until };
    } catch {
        // Unreadable: start over, which only re-checks rows that are already placed.
    }
    return null;
}

/**
 * One bounded step. Returns how many visits were given a country, and whether the
 * whole history is now done.
 */
export async function backfillVisitCountries(now = Date.now()): Promise<{ placed: number; done: boolean }> {
    const saved = parseCursor(await getSetting(CURSOR_KEY));
    if (saved === "done") return { placed: 0, done: true };

    await ensureGeoDatabase();
    // Without a database there is nothing to place them with; try again next pass.
    if (!geoDatabaseReady()) return { placed: 0, done: false };

    let cursor = saved;
    if (!cursor) {
        const oldest = await prisma.analyticsSession.findFirst({
            orderBy: { lastSeenAt: "asc" },
            select: { lastSeenAt: true }
        });
        if (!oldest) {
            await setSetting(CURSOR_KEY, "done");
            return { placed: 0, done: true };
        }
        cursor = { next: visitDay(oldest.lastSeenAt.getTime()), until: now };
    }

    let placed = 0;
    const refold = new Set<number>();
    let day = cursor.next;
    for (let walked = 0; walked < DAYS_PER_PASS && day <= cursor.until; walked += 1, day += DAY_MS) {
        let after: string | undefined;
        for (;;) {
            const rows = await prisma.analyticsSession.findMany({
                where: {
                    lastSeenAt: { gte: new Date(day), lt: new Date(day + DAY_MS) },
                    country: null,
                    ip: { not: null },
                    ...(after ? { id: { gt: after } } : {})
                },
                orderBy: { id: "asc" },
                take: BATCH,
                select: { id: true, ip: true, startedAt: true }
            });
            if (rows.length === 0) break;
            after = rows[rows.length - 1]!.id;

            // One update per country rather than one per visit.
            const byCountry = new Map<string, string[]>();
            for (const row of rows) {
                const country = countryForIp(row.ip);
                if (!country) continue;
                const ids = byCountry.get(country) ?? [];
                ids.push(row.id);
                byCountry.set(country, ids);
                refold.add(visitDay(row.startedAt.getTime()));
            }
            for (const [country, ids] of byCountry) {
                const { count } = await prisma.analyticsSession.updateMany({
                    where: { id: { in: ids }, country: null },
                    data: { country }
                });
                placed += count;
            }
            if (rows.length < BATCH) break;
        }
    }

    // Today is still moving and is read live, so only finished days are folded again.
    const today = visitDay(now);
    for (const finished of [...refold].sort((a, b) => a - b)) {
        if (finished < today) await rollupAnalyticsDay(finished);
    }

    const done = day > cursor.until;
    await setSetting(CURSOR_KEY, done ? "done" : JSON.stringify({ next: day, until: cursor.until }));
    return { placed, done };
}
