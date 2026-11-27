/**
 * What each API key's calls did: route, status and time taken, counted per hour.
 *
 * A route handler is wrapped with `withKeyUsage`, and `authenticateApiKey` marks
 * the call as a key's once the key is accepted, so a call answered for a session,
 * an OAuth token or nobody is never counted. The call is added to an in-memory
 * tally and the tally is written every few seconds, one upsert per key, hour,
 * route and status that moved (and one per program family and address that
 * called) - so a burst of a thousand calls to one route is
 * one write, not a thousand, and nothing is written while the call is answered.
 *
 * The cost of that is the last few seconds of counts when the process stops.
 * They are counters for a usage screen, not an audit trail (that is the audit
 * log), so that is the right side of the trade.
 */

import { prisma } from "@polaris/db";
import { AsyncLocalStorage } from "node:async_hooks";
import { clientFamily, originIp, originUserAgent } from "@polaris/core";
import { matchDocumentedRoute } from "@/lib/api-docs/routes";

/** Upper bounds, in ms, of the latency columns; past the last is `msOver`. */
export const LATENCY_BOUNDS = [25, 50, 100, 250, 500, 1000, 2500, 5000] as const;
export const LATENCY_COLUMNS = [
    "ms25",
    "ms50",
    "ms100",
    "ms250",
    "ms500",
    "ms1000",
    "ms2500",
    "ms5000",
    "msOver"
] as const;
export type LatencyColumn = (typeof LATENCY_COLUMNS)[number];

/** How long hourly rows are kept. */
export const RETENTION_DAYS = 90;
/** How often the tally is written. */
const FLUSH_EVERY_MS = 10_000;
/** A tally this large is written straight away rather than at the next tick. */
const FLUSH_AT_ENTRIES = 500;
/** What a call to a path this deployment does not document is filed under. */
export const OTHER_ROUTE = "(other)";
/** What a call that named no address is filed under. */
export const NO_ADDRESS = "";
/** What the addresses past `ADDRESSES_PER_HOUR` in one key's hour are filed under. */
export const OTHER_ADDRESSES = "*";
/**
 * The most addresses one key's hour is counted under, one row each. A key
 * replayed from a botnet would otherwise write a row per address; past this the
 * rest are summed as one, which is what a usage table could show of them anyway.
 */
export const ADDRESSES_PER_HOUR = 200;
/** The longest address kept: an IPv6 address with a zone fits; a forged header does not. */
const ADDRESS_MAX = 64;

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

/** Who called: the program's family and the address, per key and hour. */
export interface CallerTally {
    keyId: string;
    hour: Date;
    client: string;
    ip: string;
    calls: number;
    errors: number;
}

const pending = new Map<string, Tally>();
const pendingCallers = new Map<string, CallerTally>();
/** The addresses each key's hour has been counted under, for the cap. */
const addressesSeen = new Map<string, Set<string>>();
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
    return Object.fromEntries(LATENCY_COLUMNS.map((column) => [column, 0])) as Record<
        LatencyColumn,
        number
    >;
}

/** Add one call to the tally. Never throws, never waits. */
export function recordKeyCall(call: {
    keyId: string;
    method: string;
    pathname: string;
    status: number;
    ms: number;
    at?: Date;
    /** The caller's user-agent, read down to its family; absent for none sent. */
    userAgent?: string | null;
    /** The caller's address as the proxy forwarded it. */
    ip?: string | null;
}): void {
    const method = call.method.toUpperCase();
    const route = matchDocumentedRoute(method, call.pathname)?.path ?? OTHER_ROUTE;
    const hour = hourOf(call.at ?? new Date());
    const id = `${call.keyId}|${hour.getTime()}|${method}|${route}|${call.status}`;
    let tally = pending.get(id);
    if (!tally) {
        tally = {
            keyId: call.keyId,
            hour,
            method,
            route,
            status: call.status,
            calls: 0,
            totalMs: 0,
            latency: emptyLatency()
        };
        pending.set(id, tally);
    }
    const ms = Math.max(0, Math.round(call.ms));
    tally.calls += 1;
    tally.totalMs += ms;
    tally.latency[latencyColumn(ms)] += 1;
    countCaller(call.keyId, hour, call.userAgent, call.ip, call.status >= 400);

    if (pending.size >= FLUSH_AT_ENTRIES || pendingCallers.size >= FLUSH_AT_ENTRIES)
        void flushKeyCalls();
    else if (!timer) {
        timer = setTimeout(() => void flushKeyCalls(), FLUSH_EVERY_MS);
        timer.unref?.();
    }
}

function countCaller(
    keyId: string,
    hour: Date,
    userAgent: string | null | undefined,
    address: string | null | undefined,
    failed: boolean
): void {
    const client = clientFamily(userAgent);
    let ip = address?.trim().slice(0, ADDRESS_MAX) ?? NO_ADDRESS;
    if (ip !== NO_ADDRESS) {
        const slot = `${keyId}|${hour.getTime()}`;
        let seen = addressesSeen.get(slot);
        if (!seen) addressesSeen.set(slot, (seen = new Set()));
        if (!seen.has(ip)) {
            if (seen.size >= ADDRESSES_PER_HOUR) ip = OTHER_ADDRESSES;
            else seen.add(ip);
        }
    }
    const id = `${keyId}|${hour.getTime()}|${client}|${ip}`;
    let tally = pendingCallers.get(id);
    if (!tally) {
        tally = { keyId, hour, client, ip, calls: 0, errors: 0 };
        pendingCallers.set(id, tally);
    }
    tally.calls += 1;
    if (failed) tally.errors += 1;
}

/** What is waiting to be written. For tests. */
export function pendingKeyCalls(): Tally[] {
    return [...pending.values()];
}

/** The callers waiting to be written. For tests. */
export function pendingKeyCallers(): CallerTally[] {
    return [...pendingCallers.values()];
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
    const callers = [...pendingCallers.values()];
    pendingCallers.clear();
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
                create: {
                    ...where.apiKeyId_hour_method_route_status,
                    apiKeyId: tally.keyId,
                    calls: tally.calls,
                    totalMs: BigInt(tally.totalMs),
                    ...tally.latency
                },
                update: {
                    calls: { increment: tally.calls },
                    totalMs: { increment: BigInt(tally.totalMs) },
                    ...increments
                },
                select: { calls: true }
            });
        } catch (caught) {
            console.warn(
                "[api-usage] could not write a key's call counts",
                caught instanceof Error ? caught.message : caught
            );
        }
    }

    for (const tally of callers) {
        const where = {
            apiKeyId: tally.keyId,
            hour: tally.hour,
            client: tally.client,
            ip: tally.ip
        };
        try {
            await prisma.apiKeyCallerHour.upsert({
                where: { apiKeyId_hour_client_ip: where },
                create: { ...where, calls: tally.calls, errors: tally.errors },
                update: {
                    calls: { increment: tally.calls },
                    errors: { increment: tally.errors }
                },
                select: { calls: true }
            });
        } catch (caught) {
            console.warn(
                "[api-usage] could not write a key's caller counts",
                caught instanceof Error ? caught.message : caught
            );
        }
    }

    const hour = hourOf(now).getTime();
    if (hour !== sweptHour) {
        sweptHour = hour;
        // Only the current hour's addresses still matter for the cap.
        for (const slot of addressesSeen.keys())
            if (Number(slot.slice(slot.indexOf("|") + 1)) < hour) addressesSeen.delete(slot);
        try {
            const before = new Date(hour - RETENTION_DAYS * 24 * 60 * 60 * 1000);
            await prisma.apiKeyCallHour.deleteMany({ where: { hour: { lt: before } } });
            await prisma.apiKeyCallerHour.deleteMany({ where: { hour: { lt: before } } });
        } catch (caught) {
            console.warn(
                "[api-usage] could not trim old call counts",
                caught instanceof Error ? caught.message : caught
            );
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
                        ms: performance.now() - started,
                        userAgent: originUserAgent(request.headers),
                        ip: originIp(request.headers)
                    });
                }
            }
        });
    };
}
