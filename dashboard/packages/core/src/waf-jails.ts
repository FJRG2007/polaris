/**
 * Jails: banning an address for what it did, rather than for what it claims to be.
 *
 * The rule engine judges one request in isolation, which is all the edge can do at
 * the moment it has to decide. A jail judges a pattern over time - eight 404s in five
 * minutes, five rate-limit rejections in ten - which is the thing that actually
 * distinguishes someone enumerating your URLs from someone following a stale link.
 * This is fail2ban's model, and the defaults below are its numbers.
 *
 * It runs where the evidence is. A forwardAuth guard is called *before* the response
 * exists, so it can never see the 404 it would need to count; the access log the edge
 * already writes has every one of them. So Polaris reads that log, decides the bans,
 * and publishes them to the guard as address intelligence - which keeps the counting
 * off the hot path entirely and leaves enforcement as a Set lookup.
 *
 * Pure: given log entries and jail settings, produce bans.
 */

/** The part of an access-log entry a jail reads. Structural on purpose: the parser
 *  lives in @polaris/deploy and core does not depend on it. */
export interface HttpLogLike {
    readonly time: string | null;
    readonly ip: string;
    readonly path: string;
    readonly status: number;
}

export const WAF_JAIL_IDS = ["not-found", "rate-limited", "auth-failed", "probes"] as const;
export type WafJailId = (typeof WAF_JAIL_IDS)[number];

export interface WafJail {
    readonly id: WafJailId;
    readonly label: string;
    readonly description: string;
    readonly enabled: boolean;
    /** Matching requests inside the window before the address is banned. */
    readonly maxRetry: number;
    /** The window, in seconds. */
    readonly findTimeSec: number;
    /** How long the ban lasts, in seconds. */
    readonly banTimeSec: number;
}

/** Path fragments that are only ever requested by something enumerating exploits.
 *  The probes jail counts these regardless of the status they returned - a scan that
 *  happens to hit a 200 is still a scan. */
const PROBE_MARKERS = [
    "/wp-",
    "/xmlrpc.php",
    "/phpmyadmin",
    "/.env",
    "/.git",
    "/.aws",
    "/vendor/phpunit",
    "/eval-stdin.php",
    "/cgi-bin/",
    "/solr/",
    "/administrator/",
    "/.ssh"
];

/** Whether a log entry counts as a failure for a jail. */
function counts(jail: WafJailId, entry: HttpLogLike): boolean {
    switch (jail) {
        case "not-found":
            return entry.status === 404;
        case "rate-limited":
            return entry.status === 429;
        case "auth-failed":
            return entry.status === 401 || entry.status === 403;
        case "probes": {
            const path = entry.path?.toLowerCase() ?? "";
            return path !== "" && PROBE_MARKERS.some((marker) => path.includes(marker));
        }
    }
}

/**
 * The jails a fresh instance runs, with fail2ban's own defaults for the two it
 * shares. Everything here is editable; these are the starting numbers, not limits.
 *
 * `probes` is the aggressive one and is deliberately the strictest: three requests
 * for WordPress paths inside a minute has no innocent explanation, and unlike a 404
 * burst it cannot be produced by a broken link on someone else's site.
 */
export const DEFAULT_WAF_JAILS: readonly WafJail[] = [
    {
        id: "not-found",
        label: "Missing-page flood",
        description: "Bans an address that keeps asking for pages that do not exist - the shape of URL enumeration.",
        enabled: true,
        maxRetry: 8,
        findTimeSec: 300,
        banTimeSec: 1800
    },
    {
        id: "rate-limited",
        label: "Rate-limit flood",
        description: "Bans an address that keeps going after it has already been rate limited.",
        enabled: true,
        maxRetry: 5,
        findTimeSec: 600,
        banTimeSec: 3600
    },
    {
        id: "auth-failed",
        label: "Rejected repeatedly",
        description: "Bans an address that collects refusals - failed logins, blocked requests.",
        enabled: false,
        maxRetry: 10,
        findTimeSec: 600,
        banTimeSec: 3600
    },
    {
        id: "probes",
        label: "Exploit probing",
        description: "Bans an address that goes looking for WordPress, phpMyAdmin, .env or .git on a service that has none.",
        enabled: true,
        maxRetry: 3,
        findTimeSec: 60,
        banTimeSec: 86400
    }
];

/** How much longer each repeat offence lasts, and where that stops. A first ban is
 *  the jail's own time; the fourth is eight times it, and never more than a week. */
const ESCALATION_CAP = 8;
const BAN_SECONDS_MAX = 7 * 24 * 3600;

export interface WafBanVerdict {
    readonly ip: string;
    readonly jail: WafJailId;
    /** Epoch ms the ban lifts. */
    readonly until: number;
    /** What it was banned for, in a form a person can read. */
    readonly note: string;
    /** Matching requests that produced it. */
    readonly hits: number;
}

export interface WafJailInput {
    readonly entries: readonly HttpLogLike[];
    readonly jails: readonly WafJail[];
    /** Addresses and ranges that are never banned, whatever they do. */
    readonly ignore?: readonly string[];
    /** Times each address has been banned before, so a repeat offender is held
     *  longer than a first one. */
    readonly priorBans?: Readonly<Record<string, number>>;
    /** Epoch ms "now". */
    readonly now: number;
}

/**
 * The bans the evidence supports right now.
 *
 * One address can trip several jails; the longest ban wins, because they are all
 * describing the same address and the strictest verdict is the one that was meant.
 * Entries without a parseable time or a client address are skipped - a log line that
 * cannot be placed in the window cannot be counted against one.
 */
export function detectWafBans(input: WafJailInput): WafBanVerdict[] {
    const { entries, jails, now } = input;
    const ignore = new Set(input.ignore ?? []);
    const active = jails.filter((jail) => jail.enabled && jail.maxRetry > 0);
    if (active.length === 0 || entries.length === 0) return [];

    // One pass over the log per jail window, counting per address.
    const counters = new Map<string, Map<string, number>>();
    for (const jail of active) counters.set(jail.id, new Map());
    for (const entry of entries) {
        const ip = entry.ip;
        if (!ip || ip === "-" || ignore.has(ip)) continue;
        const at = entry.time ? Date.parse(entry.time) : NaN;
        if (!Number.isFinite(at) || at > now) continue;
        for (const jail of active) {
            if (at < now - jail.findTimeSec * 1000) continue;
            if (!counts(jail.id, entry)) continue;
            const perIp = counters.get(jail.id)!;
            perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
        }
    }

    const best = new Map<string, WafBanVerdict>();
    for (const jail of active) {
        for (const [ip, hits] of counters.get(jail.id)!) {
            if (hits < jail.maxRetry) continue;
            const repeats = Math.min(input.priorBans?.[ip] ?? 0, Math.log2(ESCALATION_CAP));
            const seconds = Math.min(jail.banTimeSec * 2 ** repeats, BAN_SECONDS_MAX);
            const verdict: WafBanVerdict = {
                ip,
                jail: jail.id,
                until: now + seconds * 1000,
                note: `${jail.label}: ${hits} in ${Math.round(jail.findTimeSec / 60)}m`,
                hits
            };
            const existing = best.get(ip);
            if (!existing || verdict.until > existing.until) best.set(ip, verdict);
        }
    }
    return [...best.values()].sort((a, b) => b.until - a.until);
}
