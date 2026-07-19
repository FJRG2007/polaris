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
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    try {
        const existing = await prisma.rateLimitCounter.findUnique({ where: { key } });
        if (!existing || now - existing.windowStart.getTime() >= windowMs) {
            await prisma.rateLimitCounter.upsert({
                where: { key },
                create: { key, count: 1, windowStart: new Date(now) },
                update: { count: 1, windowStart: new Date(now) }
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
