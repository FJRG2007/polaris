/**
 * Noticing abuse that no single request looks guilty of.
 *
 * The rule engine judges one request; the jails count refusals. Neither catches the
 * traffic that is individually well-formed and collectively wrong: one address
 * pulling the same 2 MB bundle four hundred times, a cache-buster churning
 * `?v=<random>` past the CDN, a sweep under a prefix that really exists so every
 * request 404s inside a valid route, a query string carrying a payload nobody typed.
 *
 * The comparison is always against the route's own norm rather than a fixed number,
 * because there is no rate that is wrong everywhere: a polling endpoint at 60 requests
 * a minute is healthy and a checkout page at 60 is an attack. What that buys is a
 * detector that works on a busy instance and a quiet one without being configured for
 * either.
 *
 * Pure: given log entries and a window, produce findings. Deciding what to do about
 * one is the caller's business.
 */

import { ipAllowed } from "./cidr.js";
import type { HttpLogLike } from "./waf-jails.js";

/** An access-log entry as this reads it. The method is optional because the jails do
 *  not need it and the parser does not always carry one. */
export interface WafTrafficLike extends HttpLogLike {
    readonly method?: string | null;
}

export const WAF_ANOMALY_KINDS = [
    "route-flood",
    "asset-abuse",
    "cache-buster",
    "path-enumeration",
    "query-payload",
    "method-mismatch"
] as const;

export type WafAnomalyKind = (typeof WAF_ANOMALY_KINDS)[number];

export interface WafAnomaly {
    readonly kind: WafAnomalyKind;
    readonly ip: string;
    /** The route it is about, already normalised. */
    readonly route: string;
    /** Requests from this address to this route inside the window. */
    readonly hits: number;
    /** What the rest of the traffic to this route looked like, so the number above
     *  can be judged. Null when the route has no other traffic to compare against. */
    readonly baseline: number | null;
    /** One sentence a person can act on. */
    readonly detail: string;
    /** high = act on it; low = worth seeing, not worth blocking automatically. */
    readonly severity: "high" | "low";
}

/** Extensions that are served, not computed. A browser fetches each of these once
 *  and then honours the cache; hundreds of fetches from one address is not a browser. */
const STATIC_EXTENSIONS = [
    ".js",
    ".mjs",
    ".css",
    ".map",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".mp4",
    ".webm",
    ".pdf",
    ".zip"
];

/** Markers of an injection attempt in a query string. Matched case-insensitively
 *  against the decoded value; each one is meaningless in an ordinary parameter. */
const PAYLOAD_MARKERS = [
    "union select",
    "select ",
    " or 1=1",
    "' or '",
    "sleep(",
    "benchmark(",
    "information_schema",
    "<script",
    "javascript:",
    "onerror=",
    "../../",
    "..%2f",
    "/etc/passwd",
    "$(",
    "${jndi:",
    "|curl ",
    ";wget "
];

/** A query string longer than this is not something a form produced. */
const QUERY_LENGTH_MAX = 1024;

export interface WafAnomalyOptions {
    /** Requests from one address to one route before the rate is even considered.
     *  Below this there is nothing to be confident about. */
    readonly minHits?: number;
    /** How many times the route's own median an address has to exceed to count. */
    readonly overBaseline?: number;
    /** Fetches of one static asset from one address before it stops being a browser. */
    readonly assetMax?: number;
    /** Distinct query strings against one path from one address before it reads as
     *  cache-busting rather than use. */
    readonly variantMax?: number;
}

const DEFAULTS: Required<WafAnomalyOptions> = {
    minHits: 20,
    overBaseline: 8,
    assetMax: 60,
    variantMax: 30
};

/**
 * What the detector is given on top of the thresholds an operator tunes.
 *
 * `exempt` is kept out of `WafAnomalyOptions` deliberately: the numbers above are
 * settings somebody saved, the exempt list is the firewall's one "never ban these"
 * list and is owned elsewhere. Keeping them apart is what stops a stored settings
 * blob from carrying a second, stale copy of it.
 */
export interface WafAnomalyInput extends WafAnomalyOptions {
    /**
     * Addresses and ranges that are never reported, as bare addresses or CIDR.
     *
     * An operator's own address is the case this exists for. They are the heaviest
     * legitimate user of their own instance - opening every page, reloading, pulling
     * the same bundle - and against a route's ordinary visitor that reads as a flood.
     * Reporting it teaches them the detector is wrong, which is worse than missing
     * something. They still count towards other addresses' baselines: what they do is
     * normal traffic, it is only a verdict about them that is withheld.
     */
    readonly exempt?: readonly string[];
}

/** The path with its query removed and a trailing slash normalised away, so the same
 *  route is one key however it was written. */
export function routeOf(path: string | null | undefined): string {
    if (!path) return "/";
    const cut = path.split("?")[0] ?? "/";
    const trimmed = cut.length > 1 && cut.endsWith("/") ? cut.slice(0, -1) : cut;
    return trimmed === "" ? "/" : trimmed;
}

function isStatic(route: string): boolean {
    const lower = route.toLowerCase();
    return STATIC_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function queryOf(path: string): string {
    const index = path.indexOf("?");
    return index < 0 ? "" : path.slice(index + 1);
}

/** Median of a numeric list. Median rather than mean so one attacker in the window
 *  does not raise the very baseline they are being compared against. */
function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? ((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!;
}

interface Cell {
    hits: number;
    notFound: number;
    variants: Set<string>;
    methods: Set<string>;
    payload: string | null;
    longQuery: number;
}

/**
 * The anomalies in a window of traffic.
 *
 * Entries outside [from, to) or without a parseable time are ignored, so the numbers
 * here always describe the window they claim to.
 */
export function detectWafAnomalies(
    entries: readonly WafTrafficLike[],
    from: number,
    to: number,
    options: WafAnomalyInput = {}
): WafAnomaly[] {
    const config = { ...DEFAULTS, ...options };
    const exempt = options.exempt ?? [];
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

    // route -> ip -> cell, plus the per-route totals the baseline is taken from.
    const byRoute = new Map<string, Map<string, Cell>>();
    for (const entry of entries) {
        if (!entry.ip || entry.ip === "-") continue;
        const at = entry.time ? Date.parse(entry.time) : NaN;
        if (!Number.isFinite(at) || at < from || at >= to) continue;

        const route = routeOf(entry.path);
        let perIp = byRoute.get(route);
        if (!perIp) {
            perIp = new Map();
            byRoute.set(route, perIp);
        }
        let cell = perIp.get(entry.ip);
        if (!cell) {
            cell = { hits: 0, notFound: 0, variants: new Set(), methods: new Set(), payload: null, longQuery: 0 };
            perIp.set(entry.ip, cell);
        }
        cell.hits += 1;
        if (entry.status === 404) cell.notFound += 1;
        const query = queryOf(entry.path ?? "");
        if (query !== "") {
            cell.variants.add(query);
            if (query.length > QUERY_LENGTH_MAX) cell.longQuery = Math.max(cell.longQuery, query.length);
            if (cell.payload === null) {
                const lower = decodeSafely(query).toLowerCase();
                cell.payload = PAYLOAD_MARKERS.find((marker) => lower.includes(marker)) ?? null;
            }
        }
        if (entry.method) cell.methods.add(entry.method.toUpperCase());
    }

    const found: WafAnomaly[] = [];
    for (const [route, perIp] of byRoute) {
        for (const [ip, cell] of perIp) {
            // Judged after the cells are built, not before: an exempt address is still
            // part of what a route's traffic looks like.
            if (exempt.length > 0 && ipAllowed(ip, exempt)) continue;
            // The baseline excludes the address being judged, which is what stops a
            // single heavy client from defining "normal" as itself on a quiet route.
            const peers = [...perIp].filter(([key]) => key !== ip).map(([, other]) => other.hits);
            found.push(...anomaliesFor(route, ip, cell, peers.length > 0 ? median(peers) : null, config));
        }
    }
    // Worst first: an operator reading this list should not have to sort it.
    return found.sort((a, b) => (a.severity === b.severity ? b.hits - a.hits : a.severity === "high" ? -1 : 1));
}

function anomaliesFor(
    route: string,
    ip: string,
    cell: Cell,
    base: number | null,
    config: Required<WafAnomalyOptions>
): WafAnomaly[] {
    const found: WafAnomaly[] = [];

    // A payload in the query is conclusive on its own - it takes one request, not a rate.
    if (cell.payload) {
        found.push({
            kind: "query-payload",
            ip,
            route,
            hits: cell.hits,
            baseline: base,
            severity: "high",
            detail: `Query string carried "${cell.payload}", which nothing on this route asks for.`
        });
    } else if (cell.longQuery > 0) {
        found.push({
            kind: "query-payload",
            ip,
            route,
            hits: cell.hits,
            baseline: base,
            severity: "low",
            detail: `Query string of ${cell.longQuery} characters - far past anything a form produces.`
        });
    }

    if (cell.hits >= config.minHits) {
        if (isStatic(route) && cell.hits >= config.assetMax) {
            found.push({
                kind: "asset-abuse",
                ip,
                route,
                hits: cell.hits,
                baseline: base,
                severity: "high",
                detail: `Fetched this static file ${cell.hits} times. A browser fetches it once and caches it.`
            });
        } else if (base !== null && base > 0 && cell.hits >= base * config.overBaseline) {
            found.push({
                kind: "route-flood",
                ip,
                route,
                hits: cell.hits,
                baseline: base,
                severity: "high",
                detail: `${cell.hits} requests where everyone else on this route made about ${Math.round(base)}.`
            });
        }

        if (cell.variants.size >= config.variantMax) {
            found.push({
                kind: "cache-buster",
                ip,
                route,
                hits: cell.hits,
                baseline: base,
                severity: cell.variants.size >= config.variantMax * 2 ? "high" : "low",
                detail: `${cell.variants.size} different query strings on one path - the shape of cache busting.`
            });
        }

        // A sweep under a prefix that exists: every request 404s, but inside a real
        // route, so the missing-page jail sees them spread across "different" paths.
        if (cell.notFound >= config.minHits && cell.notFound / cell.hits > 0.8) {
            found.push({
                kind: "path-enumeration",
                ip,
                route,
                hits: cell.hits,
                baseline: base,
                severity: "high",
                detail: `${cell.notFound} of ${cell.hits} requests here found nothing - walking the route, not using it.`
            });
        }
    }

    // Nothing writes to a stylesheet. A POST to one is a probe for an upload handler.
    if (isStatic(route) && [...cell.methods].some((method) => method !== "GET" && method !== "HEAD")) {
        found.push({
            kind: "method-mismatch",
            ip,
            route,
            hits: cell.hits,
            baseline: base,
            severity: "low",
            detail: `Sent ${[...cell.methods].filter((m) => m !== "GET" && m !== "HEAD").join(", ")} to a static file.`
        });
    }

    return found;
}

/** Decode percent-encoding so an encoded payload is not invisible. A malformed
 *  sequence is left as it came rather than throwing on hostile input. */
function decodeSafely(value: string): string {
    try {
        return decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
        return value;
    }
}
