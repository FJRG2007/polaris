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

import { ruleMatches } from "./waf-rules.js";
import type { HttpLogLike } from "./waf-jails.js";
import type { WafCustomRule } from "./schemas/deploy.js";

/** An entry with the two extra fields the breakdowns need. The jail runner only
 *  needs status/path/ip, so this widens it rather than duplicating it. */
export interface WafTrafficEntry extends HttpLogLike {
    readonly method?: string | null;
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

/** One request an address made, as the activity view lists it. */
export interface WafAddressRequest {
    /** Epoch ms. */
    readonly at: number;
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly host: string | null;
    readonly userAgent: string | null;
}

/** Everything one address did in a window. */
export interface WafAddressActivity {
    readonly ip: string;
    readonly from: number;
    readonly to: number;
    readonly total: number;
    readonly blocked: number;
    /** Epoch ms of the first and last request in the window, or null for neither. */
    readonly firstSeen: number | null;
    readonly lastSeen: number | null;
    /** Most recent first, capped at the caller's limit. */
    readonly requests: readonly WafAddressRequest[];
    readonly topPaths: readonly WafTopEntry[];
    readonly agents: readonly WafTopEntry[];
    /** Response codes it collected, as "404", "200" and so on. */
    readonly statuses: readonly WafTopEntry[];
    /** Whether there were more requests than `requests` carries. */
    readonly truncated: boolean;
}

/** Requests listed for one address. Enough to read the shape of a sweep; the counts
 *  above it stay exact however many there were. */
const ADDRESS_REQUEST_LIMIT = 300;

/**
 * What one address did over [from, to).
 *
 * The point of this is judging a ban rather than reporting on traffic: an operator
 * looking at "Exploit probing: 37 in 1m" needs the 37 requests to agree with it, or
 * the ban is something they have to take on trust. So the requests themselves are
 * listed, not just counted - and the totals are counted over everything in the window
 * even when the list is cut short, because a truncated list that also truncated the
 * numbers would understate exactly the addresses worth looking at.
 */
export function summarizeWafAddress(
    entries: readonly WafTrafficEntry[],
    ip: string,
    from: number,
    to: number,
    limit = ADDRESS_REQUEST_LIMIT
): WafAddressActivity {
    const requests: WafAddressRequest[] = [];
    const paths = new Map<string, number>();
    const agents = new Map<string, number>();
    const statuses = new Map<string, number>();
    let total = 0;
    let blocked = 0;
    let firstSeen: number | null = null;
    let lastSeen: number | null = null;

    for (const entry of entries) {
        if (entry.ip !== ip || !entry.time) continue;
        const at = Date.parse(entry.time);
        if (!Number.isFinite(at) || at < from || at >= to) continue;
        total += 1;
        if (isBlocked(entry)) blocked += 1;
        if (firstSeen === null || at < firstSeen) firstSeen = at;
        if (lastSeen === null || at > lastSeen) lastSeen = at;
        bump(paths, entry.path);
        bump(agents, entry.userAgent);
        bump(statuses, String(entry.status));
        requests.push({
            at,
            method: entry.method ?? "GET",
            path: entry.path,
            status: entry.status,
            host: entry.host ?? null,
            userAgent: entry.userAgent ?? null
        });
    }

    requests.sort((a, b) => b.at - a.at);
    return {
        ip,
        from,
        to,
        total,
        blocked,
        firstSeen,
        lastSeen,
        requests: requests.slice(0, Math.max(1, limit)),
        topPaths: top(paths),
        agents: top(agents, 4),
        statuses: top(statuses, 6),
        truncated: requests.length > limit
    };
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

/**
 * What one rule matches, over the same log.
 *
 * This is a REPLAY, not a record, and the distinction is the whole reason it is
 * honest: the edge log says a request was refused with a 403, not which rule refused
 * it, so counting per rule from the log alone would mean attributing a block to
 * whichever rule looks likeliest. Instead the rules are run over the traffic that
 * really arrived, and the answer is "this is what the rule matches", which is a
 * different and more useful question than "this is what it caught" - it can be asked
 * of a rule that is switched off, which is exactly when somebody wants to know.
 *
 * The screen has to say so. A count against a rule armed ten minutes ago covers the
 * whole window, and read as a history that would be a lie.
 */
export interface WafRuleActivity {
    readonly total: number;
    /** Counts per bucket, oldest first, for the sparkline. */
    readonly series: readonly number[];
}

/** One rule to replay, under the key the caller wants the answer back on. */
export interface WafRuleProbe {
    readonly key: string;
    readonly rule: WafCustomRule;
}

/**
 * Replay `probes` over `entries`, keyed as they were handed in.
 *
 * One pass over the log with every rule asked about each entry, rather than one pass
 * per rule: the log is the expensive half (megabytes of it), and a rule is a handful
 * of string comparisons. A disabled rule is replayed like any other - `ruleMatches`
 * would refuse it, so the check is against its conditions directly.
 */
export function wafRuleActivity(
    entries: readonly WafTrafficEntry[],
    probes: readonly WafRuleProbe[],
    from: number,
    to: number,
    buckets = 24
): Map<string, WafRuleActivity> {
    const count = Math.max(1, Math.min(Math.floor(buckets), 200));
    const answer = new Map<string, { total: number; series: number[] }>();
    for (const probe of probes) answer.set(probe.key, { total: 0, series: Array.from({ length: count }, () => 0) });
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || probes.length === 0) {
        return new Map([...answer].map(([key, value]) => [key, value]));
    }

    const width = (to - from) / count;
    // Enabled or not, the question is what the conditions match, so every rule is
    // replayed as if it were on.
    const armed = probes.map((probe) => ({ key: probe.key, rule: { ...probe.rule, enabled: true } }));

    for (const entry of entries) {
        if (!entry.time) continue;
        const ms = Date.parse(entry.time);
        if (!Number.isFinite(ms) || ms < from || ms >= to) continue;
        const slot = Math.min(count - 1, Math.floor((ms - from) / width));
        const facts = factsFor(entry);
        for (const { key, rule } of armed) {
            if (!ruleMatches(rule, facts)) continue;
            const bucket = answer.get(key)!;
            bucket.total += 1;
            bucket.series[slot]! += 1;
        }
    }
    return answer;
}

/**
 * A log entry as the rule engine's facts.
 *
 * The log records one path with its query still attached, which the engine keeps
 * apart - a rule about `http.request.uri.path` must not match on something that is
 * only in the query string. Splitting here is what keeps a replay saying the same
 * thing the edge would have said. The integrity headers are not logged at all, so a
 * rule that reads that check finds a request it cannot vouch for, which is the same
 * answer the guard gives for a request that sent none.
 */
function factsFor(entry: WafTrafficEntry) {
    const raw = entry.path ?? "";
    const split = raw.indexOf("?");
    return {
        ip: entry.ip === "-" ? null : entry.ip,
        host: entry.host ?? null,
        path: split < 0 ? raw : raw.slice(0, split),
        method: entry.method ?? null,
        userAgent: entry.userAgent ?? null,
        query: split < 0 ? null : raw.slice(split + 1)
    };
}
