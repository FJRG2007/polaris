/**
 * Blocking domains by what a reputation service says about them, rather than by
 * a list somebody published.
 *
 * Each domain is asked about once, after a device on the network asked for it:
 * the DNS server cannot wait for a paid lookup before it answers, so the first
 * visit to a domain nobody has asked for before goes through, and the domain is
 * blocked from the next pass on (a few minutes). What the service said is kept
 * per domain - a day for a clean one, a week for a flagged one - so a domain is
 * one lookup a day at most whoever asks for it.
 *
 * The flagged domains reach the DNS server as one file per category on its own
 * volume, which the rendered configuration names as a list, the way NextDNS and
 * AdGuard Home add their threat feeds next to the lists you picked. Everything
 * here is pure; the lookups and the file are `reputation-service.ts`'s.
 */

import { z } from "zod";
import { QUERY_LOG_DIR, parseQueryLine, type QueryRow } from "./query-log";
import { DNS_REPUTATION_CATEGORIES, type DnsReputationCategory } from "./settings";

/** How long a domain the service found nothing against is believed. */
export const CLEAN_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a flagged domain stays flagged before it is asked about again. */
export const FLAGGED_TTL_MS = 7 * CLEAN_TTL_MS;

/** Domains looked up in one pass at most, whatever the budget would allow. */
export const LOOKUPS_PER_PASS = 20;
/** Flagged domains written to the DNS server's file at most, newest first. */
export const PUBLISHED_MAX = 50_000;

/** The list group a category's flagged domains are loaded as; it is what the
 *  query log names when one of them is blocked. */
export function reputationList(category: DnsReputationCategory): string {
    return `dymo-${category}`;
}

/** The category a list group is, or null when it is not a reputation list. */
export function reputationCategoryOf(list: string): DnsReputationCategory | null {
    const category = list.startsWith("dymo-") ? list.slice("dymo-".length) : "";
    return (DNS_REPUTATION_CATEGORIES as readonly string[]).includes(category)
        ? (category as DnsReputationCategory)
        : null;
}

/** Where a category's file lives inside the DNS server's container. */
export function reputationListPath(category: DnsReputationCategory): string {
    return `${QUERY_LOG_DIR}/reputation-${category}.txt`;
}

/** When a verdict should be asked for again. */
export function verdictExpiry(flagged: boolean, now: number): Date {
    return new Date(now + (flagged ? FLAGGED_TTL_MS : CLEAN_TTL_MS));
}

/** Endings that only ever name something on this network, never a site. */
const LOCAL_ENDINGS = /\.(?:local|lan|home|internal|arpa|localdomain|home\.arpa|test|invalid)$/;
const IP_LIKE = /^[\d.]+$|:/;

/**
 * Whether a looked-up name is one worth asking about: a public name with a dot,
 * that is not an address, nor this network's own.
 */
export function worthChecking(domain: string): boolean {
    if (!domain.includes(".") || domain.length > 253) return false;
    if (IP_LIKE.test(domain) || LOCAL_ENDINGS.test(domain)) return false;
    return /^[a-z0-9.-]+$/.test(domain);
}

/**
 * The names allowed lookups asked for, newest first and each once, from the
 * end of the query log. Blocked lookups are skipped: something already stops
 * them, and asking about them would spend the budget on names that cost nothing.
 */
export function namesFromLog(text: string, limit: number): string[] {
    const seen = new Set<string>();
    const lines = text.split("\n");
    for (let at = lines.length - 1; at >= 0 && seen.size < limit; at -= 1) {
        const row: QueryRow | null = parseQueryLine(lines[at] ?? "");
        if (!row || row.outcome !== "allowed" || row.via === "local") continue;
        if (worthChecking(row.domain)) seen.add(row.domain);
    }
    return [...seen];
}

/** One verdict as it is kept. */
export interface DomainVerdict {
    readonly domain: string;
    readonly fraud: boolean;
    readonly adult: boolean;
}

/**
 * Each category's file: the flagged domains in it, sorted, one per line. A
 * category with nothing flagged is still a file, so the list the configuration
 * names always loads.
 */
export function reputationFiles(
    verdicts: readonly DomainVerdict[],
    categories: readonly DnsReputationCategory[]
): Map<DnsReputationCategory, string> {
    const files = new Map<DnsReputationCategory, string>();
    for (const category of categories) {
        const names = [
            ...new Set(verdicts.filter((verdict) => verdict[category]).map((v) => v.domain))
        ].sort();
        // A comment line keeps an empty list a list rather than a missing file.
        files.set(category, `${["# Polaris: domains Dymo flagged", ...names].join("\n")}\n`);
    }
    return files;
}

/** What the screen sends to unblock or check one flagged domain again. */
export const reputationDomainSchema = z.object({
    domain: z
        .string()
        .trim()
        .toLowerCase()
        .max(253)
        .refine((value) => worthChecking(value), "invalidDomain")
});

/** Why reputation lookups are not running, or null when they are. */
export type ReputationOff = "integrationOff" | "noKey" | "noCategory";
