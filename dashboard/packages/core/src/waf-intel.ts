/**
 * The address intelligence the edge enforces: automatic bans, Tor exit nodes, and
 * addresses a reputation provider flagged.
 *
 * All three are the same shape of problem and none of them fits in the per-request
 * header the rest of the firewall travels in. The Tor exit list alone is a few
 * thousand addresses; stamping that onto every request would cost more than the
 * check it enables. So they travel out of band instead: Polaris writes a snapshot
 * file into the directory the edge already shares, and the guard holds it in memory.
 *
 * What that buys, in order of importance:
 *
 *   - The hot path never does I/O and never makes a network call. A verdict is a Set
 *     lookup, and a reputation provider being slow or down cannot slow down or break
 *     a single request.
 *   - The last snapshot stays on disk, so the edge keeps enforcing every ban and
 *     every flagged address while the control plane is down - the same property the
 *     header-carried rules have.
 *   - A ban expires by timestamp rather than by anyone remembering to lift it, so a
 *     guard that never gets another snapshot forgets its bans instead of turning a
 *     transient block into a permanent one.
 *
 * This module is pure and holds the format plus the matcher; reading and writing the
 * file belongs to the two sides.
 */

import { ipAllowed } from "./cidr.js";

/** Bumped when the shape changes incompatibly. A guard that does not recognise the
 *  version ignores the file rather than guessing at it. */
export const WAF_INTEL_VERSION = 1;

/** Why an address is in the snapshot, so a block can say so and the analytics can
 *  separate "we banned this one" from "a provider told us about it". */
export const WAF_INTEL_REASONS = ["ban", "tor", "reputation", "manual"] as const;
export type WafIntelReason = (typeof WAF_INTEL_REASONS)[number];

export interface WafIntelEntry {
    readonly reason: WafIntelReason;
    /** Epoch ms the entry stops applying, or null for "until it is withdrawn". */
    readonly until: number | null;
    /** Short human-readable cause ("404 flood", "CriminalIP: scanner"). */
    readonly note?: string;
}

export interface WafIntelSnapshot {
    readonly v: number;
    /** Epoch ms this snapshot was produced, so a stale one is recognisable. */
    readonly at: number;
    /** Single addresses, which is what almost everything here is - a ban, a Tor exit,
     *  a flagged host. Keyed for O(1) lookup at any size. */
    readonly ips: Readonly<Record<string, WafIntelEntry>>;
    /** Ranges, kept separate because they cost a linear scan and are rare. */
    readonly cidrs: readonly (readonly [string, WafIntelEntry])[];
}

export const EMPTY_WAF_INTEL: WafIntelSnapshot = { v: WAF_INTEL_VERSION, at: 0, ips: {}, cidrs: [] };

/**
 * The snapshot as the guard queries it. Built once per file read, then asked once
 * per request: the whole point is that `match` does no parsing, no allocation in the
 * common case, and no I/O.
 */
export interface WafIntelIndex {
    readonly at: number;
    readonly size: number;
    /** The entry blocking this address right now, or null. */
    match(ip: string | null | undefined, now: number): WafIntelEntry | null;
}

/** True while the entry still applies. A null expiry never lapses; it is withdrawn
 *  by the next snapshot not containing it. */
function live(entry: WafIntelEntry, now: number): boolean {
    return entry.until === null || entry.until > now;
}

/** Index a snapshot for lookup. Tolerates a foreign or malformed value by indexing
 *  nothing: an unreadable snapshot must not block traffic, because it would block
 *  all of it. */
export function indexWafIntel(snapshot: unknown): WafIntelIndex {
    const parsed = asSnapshot(snapshot);
    const ips = new Map<string, WafIntelEntry>(Object.entries(parsed.ips));
    const cidrs = parsed.cidrs;
    return {
        at: parsed.at,
        size: ips.size + cidrs.length,
        match(ip, now) {
            if (!ip) return null;
            const exact = ips.get(ip);
            if (exact && live(exact, now)) return exact;
            for (const [range, entry] of cidrs) {
                if (live(entry, now) && ipAllowed(ip, [range])) return entry;
            }
            return null;
        }
    };
}

/** Validate the decoded file without a schema dependency - this runs in the guard,
 *  which is deliberately tiny, and it must never throw on hostile input. */
function asSnapshot(value: unknown): WafIntelSnapshot {
    if (!value || typeof value !== "object") return EMPTY_WAF_INTEL;
    const raw = value as Partial<WafIntelSnapshot>;
    if (raw.v !== WAF_INTEL_VERSION) return EMPTY_WAF_INTEL;
    const ips: Record<string, WafIntelEntry> = {};
    if (raw.ips && typeof raw.ips === "object") {
        for (const [ip, entry] of Object.entries(raw.ips)) {
            const parsed = asEntry(entry);
            if (parsed) ips[ip] = parsed;
        }
    }
    const cidrs: [string, WafIntelEntry][] = [];
    if (Array.isArray(raw.cidrs)) {
        for (const pair of raw.cidrs) {
            if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
            const parsed = asEntry(pair[1]);
            if (parsed) cidrs.push([pair[0], parsed]);
        }
    }
    return { v: WAF_INTEL_VERSION, at: typeof raw.at === "number" ? raw.at : 0, ips, cidrs };
}

function asEntry(value: unknown): WafIntelEntry | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Partial<WafIntelEntry>;
    if (!WAF_INTEL_REASONS.includes(raw.reason as WafIntelReason)) return null;
    const until = raw.until;
    if (until !== null && typeof until !== "number") return null;
    return {
        reason: raw.reason as WafIntelReason,
        until,
        ...(typeof raw.note === "string" ? { note: raw.note } : {})
    };
}

/** Assemble a snapshot, dropping anything that has already expired so the file does
 *  not grow without bound. */
export function buildWafIntel(
    entries: Iterable<readonly [string, WafIntelEntry]>,
    now: number
): WafIntelSnapshot {
    const ips: Record<string, WafIntelEntry> = {};
    const cidrs: [string, WafIntelEntry][] = [];
    for (const [address, entry] of entries) {
        if (!live(entry, now)) continue;
        if (address.includes("/")) cidrs.push([address, entry]);
        else ips[address] = entry;
    }
    return { v: WAF_INTEL_VERSION, at: now, ips, cidrs };
}
