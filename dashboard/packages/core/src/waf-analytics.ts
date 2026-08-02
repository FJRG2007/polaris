/**
 * What the firewall actually did, folded out of the edge's access log.
 *
 * Derived rather than stored, on purpose. Every request already lands in one log the
 * edge writes; counting them again into a table of our own would mean a second write
 * per request, a retention policy, and two sources that can disagree about the same
 * traffic. Reading the log answers the same questions and cannot drift from it.
 *
 * The trade is that history reaches exactly as far back as the log does. That is the
 * honest limit and the UI says so, rather than implying a month of history it does
 * not have.
 *
 * Pure: given entries and a window, produce the summary.
 */

import type { HttpLogLike } from "./waf-jails.js";

/** An entry with the two extra fields the breakdowns need. The jail runner only
 *  needs status/path/ip, so this widens it rather than duplicating it. */
export interface WafTrafficEntry extends HttpLogLike {
    readonly userAgent?: string | null;
    readonly host?: string | null;
}

export interface WafTrafficPoint {
    /** Bucket start (epoch ms). */
    readonly t: number;
    readonly allowed: number;
    readonly blocked: number;
}

export interface WafTopEntry {
    readonly value: string;
    readonly count: number;
}

export interface WafTrafficSummary {
    readonly from: number;
    readonly to: number;
    readonly total: number;
    readonly blocked: number;
    /** Percent of traffic the firewall turned away, or null when there was none. */
    readonly blockedRate: number | null;
    readonly series: readonly WafTrafficPoint[];
    readonly topAddresses: readonly WafTopEntry[];
    readonly topPaths: readonly WafTopEntry[];
    readonly topAgents: readonly WafTopEntry[];
}

/**
 * A 403 at the edge is the firewall's signature: the guard answers the forwardAuth
 * check with it, and Traefik's native allowlist middleware does the same. An app can
 * also return 403 of its own accord, so this over-counts slightly on a service that
 * does its own authorization - which is why the figure is presented as "blocked at
 * the edge" and the ban list, which is exact, is shown beside it.
 */
function isBlocked(entry: WafTrafficEntry): boolean {
    return entry.status === 403;
}

const TOP_N = 8;

/** The `count` most frequent values, most frequent first. */
function top(counts: Map<string, number>, limit = TOP_N): WafTopEntry[] {
    return [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, limit);
}

function bump(counts: Map<string, number>, key: string | null | undefined): void {
    if (!key || key === "-") return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Summarize traffic over [from, to) into `buckets` evenly spaced points plus the
 * breakdowns of what was turned away. Entries outside the window, or without a time
 * that parses, are ignored - they cannot be placed on the series and counting them
 * only in the totals would make the two disagree.
 */
export function summarizeWafTraffic(
    entries: readonly WafTrafficEntry[],
    from: number,
    to: number,
    buckets = 48
): WafTrafficSummary {
    const count = Math.max(1, Math.min(Math.floor(buckets), 500));
    const empty: WafTrafficSummary = {
        from,
        to,
        total: 0,
        blocked: 0,
        blockedRate: null,
        series: [],
        topAddresses: [],
        topPaths: [],
        topAgents: []
    };
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return empty;

    const width = (to - from) / count;
    const series = Array.from({ length: count }, (_, index) => ({
        t: Math.round(from + index * width),
        allowed: 0,
        blocked: 0
    }));
    const addresses = new Map<string, number>();
    const paths = new Map<string, number>();
    const agents = new Map<string, number>();
    let total = 0;
    let blocked = 0;

    for (const entry of entries) {
        if (!entry.time) continue;
        const ms = Date.parse(entry.time);
        if (!Number.isFinite(ms) || ms < from || ms >= to) continue;
        const slot = series[Math.min(count - 1, Math.floor((ms - from) / width))]!;
        total += 1;
        if (isBlocked(entry)) {
            blocked += 1;
            slot.blocked += 1;
            // The breakdowns describe what was turned away, not all traffic: "top
            // paths" that mixed the homepage in with /wp-login.php would say nothing.
            bump(addresses, entry.ip);
            bump(paths, entry.path);
            bump(agents, entry.userAgent);
        } else {
            slot.allowed += 1;
        }
    }

    return {
        from,
        to,
        total,
        blocked,
        blockedRate: total > 0 ? (blocked / total) * 100 : null,
        series,
        topAddresses: top(addresses),
        topPaths: top(paths),
        topAgents: top(agents)
    };
}
