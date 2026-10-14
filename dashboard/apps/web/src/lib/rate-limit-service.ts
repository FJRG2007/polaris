/**
 * Fixed-window rate limiter backed by the database. Used to throttle password
 * guesses on public links (per link + client IP) so a share or drop point cannot
 * be brute-forced. It is intentionally simple - a counter per key that resets
 * once its window elapses; adequate for guess-throttling on a self-hosted
 * instance. A distributed deployment can replace this with Redis for atomic,
 * cross-node counting without changing call sites.
 */

import { prisma } from "@polaris/db";

export interface RateLimitResult {
    readonly ok: boolean;
    /** Milliseconds until the window resets, when blocked. */
    readonly retryAfterMs: number;
}

/**
 * Count one attempt against `key`. Returns ok=false once `limit` attempts have
 * occurred within `windowMs`. The window is per key and resets on first use
 * after it elapses. Never throws - on a storage error it fails open (allows the
 * attempt) so a transient DB issue cannot lock everyone out of their own links.
 */
export async function rateLimit(
    key: string,
    limit: number,
    windowMs: number
): Promise<RateLimitResult> {
    const now = Date.now();
    try {
        const existing = await prisma.rateLimitCounter.findUnique({ where: { key } });
        if (!existing || now - existing.windowStart.getTime() >= windowMs) {
            const window = {
                count: 1,
                windowStart: new Date(now),
                expiresAt: new Date(now + windowMs)
            };
            await prisma.rateLimitCounter.upsert({
                where: { key },
                create: { key, ...window },
                update: window
            });
            return { ok: true, retryAfterMs: 0 };
        }
        if (existing.count >= limit) {
            return { ok: false, retryAfterMs: windowMs - (now - existing.windowStart.getTime()) };
        }
        await prisma.rateLimitCounter.update({ where: { key }, data: { count: { increment: 1 } } });
        return { ok: true, retryAfterMs: 0 };
    } catch {
        return { ok: true, retryAfterMs: 0 };
    }
}

/** Clear a key's counter (e.g. after a successful unlock). Never throws. */
export async function resetRateLimit(key: string): Promise<void> {
    try {
        await prisma.rateLimitCounter.deleteMany({ where: { key } });
    } catch {
        // Best-effort.
    }
}

/** Counters written before `expiresAt` existed carry no window, so they are aged
 *  out by their start instead. The longest window any caller uses is an hour. */
const LEGACY_COUNTER_TTL_MS = 24 * 60 * 60 * 1000;
/** Rows deleted per statement, and statements per pass. */
const SWEEP_BATCH = 1000;
const SWEEP_MAX_BATCHES = 50;

/**
 * Delete every counter whose window has run out. Keys are per IP, per link, per
 * account, so without this the table holds one row for every visitor and every
 * deleted account, forever. A counter past its window counts nothing - the next
 * attempt on that key starts a new one either way.
 */
export async function sweepRateLimits(now: Date = new Date()): Promise<number> {
    const where = {
        OR: [
            { expiresAt: { lt: now } },
            {
                expiresAt: null,
                windowStart: { lt: new Date(now.getTime() - LEGACY_COUNTER_TTL_MS) }
            }
        ]
    };
    let deleted = 0;
    for (let pass = 0; pass < SWEEP_MAX_BATCHES; pass++) {
        const rows = await prisma.rateLimitCounter.findMany({
            where,
            select: { id: true },
            take: SWEEP_BATCH
        });
        if (rows.length === 0) break;
        deleted += (
            await prisma.rateLimitCounter.deleteMany({
                where: { id: { in: rows.map((row) => row.id) } }
            })
        ).count;
        if (rows.length < SWEEP_BATCH) break;
    }
    return deleted;
}
