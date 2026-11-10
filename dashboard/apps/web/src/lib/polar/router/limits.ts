/**
 * A key's own allowance, as the router holds it to.
 *
 * Requests a minute and calls at once are counted in this process: a sliding
 * one-minute log and a counter of calls in flight, the same pair
 * free-claude-code keeps per provider (`providers/admission_capacity.py`),
 * here per key because a free tier is a per-key allowance. A dashboard that
 * runs as more than one process would count each separately; one Polaris runs
 * one web process.
 *
 * Requests and tokens a day and tokens a month are read from what was recorded
 * (`PolarUsage.keyId`), so they hold across restarts and include every surface
 * that spends a key - chat, helpers, voice, the compatible API.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { hasKeyLimits, type KeyLimits, type KeyState } from "@/lib/agents/key-limits";

const MINUTE = 60_000;

/** The calls started in the last minute and the calls in flight, per key. */
const started = new Map<string, number[]>();
const inFlight = new Map<string, number>();

/** What admitting a call answers: a release to call when it ends, or how long
 *  until a slot opens. */
export type Admission = { ok: true; release: () => void } | { ok: false; retryInMs: number };

const NOOP = () => undefined;

/**
 * Take a slot for one call on this key, or say when one opens. A key with no
 * minute or concurrency limit is always admitted.
 */
export function admit(
    keyId: string | undefined,
    limits: KeyLimits | undefined,
    now = Date.now()
): Admission {
    if (!keyId || !limits) return { ok: true, release: NOOP };
    const { requestsPerMinute, concurrency } = limits;
    if (requestsPerMinute === null && concurrency === null) return { ok: true, release: NOOP };
    const log = (started.get(keyId) ?? []).filter((at) => now - at < MINUTE);
    if (requestsPerMinute !== null && log.length >= requestsPerMinute) {
        started.set(keyId, log);
        return { ok: false, retryInMs: Math.max(1, MINUTE - (now - log[0]!)) };
    }
    const running = inFlight.get(keyId) ?? 0;
    if (concurrency !== null && running >= concurrency) {
        started.set(keyId, log);
        return { ok: false, retryInMs: 1_000 };
    }
    log.push(now);
    started.set(keyId, log);
    inFlight.set(keyId, running + 1);
    let released = false;
    return {
        ok: true,
        release: () => {
            if (released) return;
            released = true;
            const left = (inFlight.get(keyId) ?? 1) - 1;
            if (left > 0) inFlight.set(keyId, left);
            else inFlight.delete(keyId);
        }
    };
}

/** Calls in flight and started this minute on a key, for its screen. */
export function keyPressure(keyId: string, now = Date.now()): { inFlight: number; lastMinute: number } {
    return {
        inFlight: inFlight.get(keyId) ?? 0,
        lastMinute: (started.get(keyId) ?? []).filter((at) => now - at < MINUTE).length
    };
}

/** Forget every count. For tests. */
export function resetKeyAdmission(): void {
    started.clear();
    inFlight.clear();
}

/** The first moment of the current UTC day. */
export function dayStart(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The first moment of the current UTC calendar month. */
export function monthStartUtc(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** What a key spent today and this month. */
export interface KeySpend {
    requestsToday: number;
    tokensToday: number;
    tokensThisMonth: number;
}

const NOTHING: KeySpend = { requestsToday: 0, tokensToday: 0, tokensThisMonth: 0 };

/**
 * What each key spent today and this month, from the recorded answers: two
 * grouped reads on the `[keyId, createdAt]` index, whatever the number of
 * keys. Keys with no row spent nothing.
 */
export async function keySpend(keyIds: readonly string[], now = new Date()): Promise<Map<string, KeySpend>> {
    const found = new Map<string, KeySpend>();
    if (keyIds.length === 0) return found;
    const ids = [...new Set(keyIds)];
    const [today, month] = await Promise.all([
        prisma.polarUsage.groupBy({
            by: ["keyId"],
            where: { keyId: { in: ids }, createdAt: { gte: dayStart(now) } },
            _count: { _all: true },
            _sum: { inputTokens: true, outputTokens: true }
        }),
        prisma.polarUsage.groupBy({
            by: ["keyId"],
            where: { keyId: { in: ids }, createdAt: { gte: monthStartUtc(now) } },
            _sum: { inputTokens: true, outputTokens: true }
        })
    ]);
    for (const row of today) {
        if (!row.keyId) continue;
        found.set(row.keyId, {
            ...NOTHING,
            requestsToday: row._count._all,
            tokensToday: (row._sum.inputTokens ?? 0) + (row._sum.outputTokens ?? 0)
        });
    }
    for (const row of month) {
        if (!row.keyId) continue;
        found.set(row.keyId, {
            ...(found.get(row.keyId) ?? NOTHING),
            tokensThisMonth: (row._sum.inputTokens ?? 0) + (row._sum.outputTokens ?? 0)
        });
    }
    return found;
}

/** Whether a key has spent its own day or month allowance. Pure. */
export function allowanceState(limits: KeyLimits, spend: KeySpend | undefined): KeyState {
    const spent = spend ?? NOTHING;
    if (limits.tokensPerMonth !== null && spent.tokensThisMonth >= limits.tokensPerMonth) {
        return "limit_month";
    }
    if (limits.requestsPerDay !== null && spent.requestsToday >= limits.requestsPerDay) return "limit_day";
    if (limits.tokensPerDay !== null && spent.tokensToday >= limits.tokensPerDay) return "limit_day";
    return "ready";
}

/**
 * The keys among these that have spent their day or month allowance. Reads
 * the recorded usage only for keys that set one of those limits.
 */
export async function spentKeys(
    keys: ReadonlyArray<{ keyId?: string; limits?: KeyLimits }>
): Promise<Set<string>> {
    const limited = keys.filter(
        (key): key is { keyId: string; limits: KeyLimits } =>
            !!key.keyId &&
            !!key.limits &&
            hasKeyLimits({ ...key.limits, requestsPerMinute: null, concurrency: null })
    );
    if (limited.length === 0) return new Set();
    const spend = await keySpend(limited.map((key) => key.keyId)).catch(() => new Map<string, KeySpend>());
    return new Set(
        limited
            .filter((key) => allowanceState(key.limits, spend.get(key.keyId)) !== "ready")
            .map((key) => key.keyId)
    );
}
