/**
 * What each API key's calls did: route, status and time taken, counted per hour.
 *
 * A route handler is wrapped with `withKeyUsage`, and `authenticateApiKey` marks
 * the call as a key's once the key is accepted, so a call answered for a session,
 * an OAuth token or nobody is never counted. The call is added to an in-memory
 * tally and the tally is written every few seconds, one upsert per key, hour,
 * route and status that moved - so a burst of a thousand calls to one route is
 * one write, not a thousand, and nothing is written while the call is answered.
 *
 * The cost of that is the last few seconds of counts when the process stops.
 * They are counters for a usage screen, not an audit trail (that is the audit
 * log), so that is the right side of the trade.
 */

import { prisma } from "@polaris/db";
import { AsyncLocalStorage } from "node:async_hooks";
import { matchDocumentedRoute } from "@/lib/api-docs/routes";

/** Upper bounds, in ms, of the latency columns; past the last is `msOver`. */
export const LATENCY_BOUNDS = [25, 50, 100, 250, 500, 1000, 2500, 5000] as const;
export const LATENCY_COLUMNS = ["ms25", "ms50", "ms100", "ms250", "ms500", "ms1000", "ms2500", "ms5000", "msOver"] as const;
export type LatencyColumn = (typeof LATENCY_COLUMNS)[number];

/** How long hourly rows are kept. */
export const RETENTION_DAYS = 90;
/** How often the tally is written. */
const FLUSH_EVERY_MS = 10_000;
/** A tally this large is written straight away rather than at the next tick. */
const FLUSH_AT_ENTRIES = 500;
/** What a call to a path this deployment does not document is filed under. */
export const OTHER_ROUTE = "(other)";

interface Slot {
    keyId: string | null;
}

const scope = new AsyncLocalStorage<Slot>();

/** Called by key authentication: this request is a key's, and which. */
export function noteKeyCall(keyId: string): void {
    const slot = scope.getStore();
    if (slot) slot.keyId = keyId;
}

export interface Tally {
    keyId: string;
    hour: Date;
    method: string;
    route: string;
    status: number;
    calls: number;
    totalMs: number;
    latency: Record<LatencyColumn, number>;
}

const pending = new Map<string, Tally>();
let timer: ReturnType<typeof setTimeout> | null = null;
let sweptHour = 0;

export function hourOf(at: Date): Date {
    const hour = new Date(at);
    hour.setUTCMinutes(0, 0, 0);
    return hour;
}

export function latencyColumn(ms: number): LatencyColumn {
    const index = LATENCY_BOUNDS.findIndex((bound) => ms <= bound);
    return LATENCY_COLUMNS[index === -1 ? LATENCY_COLUMNS.length - 1 : index]!;
}

function emptyLatency(): Record<LatencyColumn, number> {
    return Object.fromEntries(LATENCY_COLUMNS.map((column) => [column, 0])) as Record<LatencyColumn, number>;
}

/** Add one call to the tally. Never throws, never waits. */
export function recordKeyCall(call: {
    keyId: string;
    method: string;
    pathname: string;
    status: number;
    ms: number;
    at?: Date;
}): void {
    const method = call.method.toUpperCase();
    const route = matchDocumentedRoute(method, call.pathname)?.path ?? OTHER_ROUTE;
    const hour = hourOf(call.at ?? new Date());
    const id = `${call.keyId}|${hour.getTime()}|${method}|${route}|${call.status}`;
    let tally = pending.get(id);
    if (!tally) {
        tally = { keyId: call.keyId, hour, method, route, status: call.status, calls: 0, totalMs: 0, latency: emptyLatency() };
        pending.set(id, tally);
    }
    const ms = Math.max(0, Math.round(call.ms));
    tally.calls += 1;
    tally.totalMs += ms;
    tally.latency[latencyColumn(ms)] += 1;

    if (pending.size >= FLUSH_AT_ENTRIES) void flushKeyCalls();
    else if (!timer) {
        timer = setTimeout(() => void flushKeyCalls(), FLUSH_EVERY_MS);
        timer.unref?.();
    }
}

/** What is waiting to be written. For tests. */
export function pendingKeyCalls(): Tally[] {
    return [...pending.values()];
}

/**
 * Write the tally: one increment per row, then - the first time a flush lands
 * in a new hour - drop the rows past the retention window. A row that cannot be
 * written (its key was deleted a moment ago) is dropped with it.
 */
export async function flushKeyCalls(now = new Date()): Promise<void> {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    const batch = [...pending.values()];
    pending.clear();
    for (const tally of batch) {
        const where = {
            apiKeyId_hour_method_route_status: {
                apiKeyId: tally.keyId,
                hour: tally.hour,
                method: tally.method,
                route: tally.route,
                status: tally.status
            }
        };
        const increments = Object.fromEntries(
            LATENCY_COLUMNS.map((column) => [column, { increment: tally.latency[column] }])
        );
        try {
            await prisma.apiKeyCallHour.upsert({
                where,
                create: { ...where.apiKeyId_hour_method_route_status, apiKeyId: tally.keyId, calls: tally.calls, totalMs: BigInt(tally.totalMs), ...tally.latency },
                update: { calls: { increment: tally.calls }, totalMs: { increment: BigInt(tally.totalMs) }, ...increments },
                select: { calls: true }
            });
        } catch (caught) {
            console.warn("[api-usage] could not write a key's call counts", caught instanceof Error ? caught.message : caught);
        }
    }

    const hour = hourOf(now).getTime();
    if (hour !== sweptHour) {
        sweptHour = hour;
        try {
            await prisma.apiKeyCallHour.deleteMany({
                where: { hour: { lt: new Date(hour - RETENTION_DAYS * 24 * 60 * 60 * 1000) } }
            });
        } catch (caught) {
            console.warn("[api-usage] could not trim old call counts", caught instanceof Error ? caught.message : caught);
        }
    }
}

/**
 * Wrap a route handler so a call answered for an API key is counted: which
 * route, which status, and how long until the response was handed back (for a
 * stream, until it started).
 */
export function withKeyUsage<Args extends [Request, ...unknown[]]>(
    handler: (...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
    return (...args: Args) => {
        const slot: Slot = { keyId: null };
        return scope.run(slot, async () => {
            const started = performance.now();
            let status = 500;
            try {
                const response = await handler(...args);
                status = response.status;
                return response;
            } finally {
                if (slot.keyId) {
                    const request = args[0];
                    recordKeyCall({
                        keyId: slot.keyId,
                        method: request.method,
                        pathname: new URL(request.url).pathname,
                        status,
                        ms: performance.now() - started
                    });
                }
            }
        });
    };
}
