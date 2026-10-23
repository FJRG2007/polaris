/**
 * What the Network filter shows before its reads answer: the last status and
 * the last unfiltered numbers this tab saw, drawn at once and replaced when
 * the fresh ones arrive, and the Overview's numbers asked for at the same time
 * as the status instead of after it.
 *
 * Held for the tab only: the numbers name the network's devices and what they
 * looked up, which must not stay on a shared computer once it is closed.
 * Browser storage can be missing or refuse (a private window, cleared data), so
 * every access is guarded and a miss simply means waiting for the read.
 */

import * as polls from "./dns-blocker-polls";
import type { DnsInsights } from "@/lib/dns-blocker/insights";
import type { QueryFilter } from "@/lib/dns-blocker/query-log";
import type { DnsBlockerStatus } from "@/lib/dns-blocker/service";

const STATUS_KEY = "polaris:network-filter:status";
const INSIGHTS_KEY = "polaris:network-filter:insights";
/** Older than this, the last numbers are not worth drawing: wait for the read. */
const MAX_AGE_MS = 30 * 60_000;
/** How long a read asked ahead waits for the screen that asked it. */
const PRIMED_MS = 10_000;

type Answer = Awaited<ReturnType<typeof polls.dnsInsights>>;

/** What of the status is kept: the settings arrive with the page anyway. */
type KeptStatus = Pick<DnsBlockerStatus, "state" | "address" | "stale">;

function load<T>(key: string): T | null {
    try {
        const raw = window.sessionStorage.getItem(key);
        if (!raw) return null;
        const held = JSON.parse(raw) as { at: number; value: T };
        return Date.now() - held.at < MAX_AGE_MS ? held.value : null;
    } catch {
        return null;
    }
}

function keep(key: string, value: unknown): void {
    try {
        window.sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), value }));
    } catch {
        // Full or refused: the next visit waits for the read, as before.
    }
}

const unfiltered = (filter: QueryFilter) =>
    filter.range === "24h" &&
    filter.page === 0 &&
    !filter.search &&
    filter.outcome === "all" &&
    !filter.client &&
    !filter.type;

export function lastStatus(settings: DnsBlockerStatus["settings"]): DnsBlockerStatus | null {
    const held = load<KeptStatus>(STATUS_KEY);
    return held ? { ...held, settings } : null;
}

export function keepStatus(status: DnsBlockerStatus): void {
    keep(STATUS_KEY, { state: status.state, address: status.address, stale: status.stale });
}

/** The last unfiltered numbers this tab saw, for a filter that is that. */
export function lastInsights(filter: QueryFilter): DnsInsights | null {
    return unfiltered(filter) ? load<DnsInsights>(INSIGHTS_KEY) : null;
}

export function keepInsights(filter: QueryFilter, insights: DnsInsights): void {
    if (unfiltered(filter)) keep(INSIGHTS_KEY, insights);
}

let primed: { key: string; at: number; read: Promise<Answer> } | null = null;

/** Ask for a filter's numbers now, for a card that is not on screen yet. */
export function primeInsights(filter: QueryFilter): void {
    const key = JSON.stringify(filter);
    if (primed?.key === key && Date.now() - primed.at < PRIMED_MS) return;
    const read = polls.dnsInsights(filter, false);
    // Whoever takes it handles a failure; one nobody takes is dropped quietly.
    read.catch(() => undefined);
    primed = { key, at: Date.now(), read };
}

/** A filter's numbers: the read asked ahead when there is one, else a new one. */
export function readInsights(
    filter: QueryFilter,
    fresh: boolean,
    signal?: AbortSignal
): Promise<Answer> {
    const key = JSON.stringify(filter);
    if (!fresh && primed?.key === key && Date.now() - primed.at < PRIMED_MS) {
        const { read } = primed;
        primed = null;
        return read;
    }
    return polls.dnsInsights(filter, fresh, signal);
}
