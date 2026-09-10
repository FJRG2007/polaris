/**
 * Which wildcard certificates Polaris should hold, and when each is due - the
 * decisions behind `managed-certificates`, kept apart from the database and the
 * network so they can be asserted.
 *
 * Two things ask for one:
 *
 * - A verified owner domain: `*.example.com` and `example.com`, so every hostname
 *   minted under it is served over trusted HTTPS from its first request instead
 *   of waiting for a per-hostname order to finish.
 * - A wildcard hostname a service answers on (`*.shop.example.com`), which no
 *   per-hostname order can ever cover. Only where its owner has standing over the
 *   name: it is under an owner domain of theirs, or they run this Polaris. Anyone
 *   else's would be an order in a zone somebody else holds, written with a token
 *   that was not handed over for it.
 */

export const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

/** The shortest and longest wait after a failed attempt. */
const FIRST_RETRY_MS = 15 * 60 * 1000;
const LONGEST_RETRY_MS = 24 * 60 * 60 * 1000;

export interface OwnerDomainFacts {
    readonly id: string;
    readonly domain: string;
    readonly verified: boolean;
    readonly userId: string | null;
    readonly orgId: string | null;
}

export interface WildcardHostFacts {
    /** As stored, `*.` included. */
    readonly hostname: string;
    /** An uploaded certificate is served for it instead; nothing to order. */
    readonly hasUpload: boolean;
    /** Who owns the service it is on. */
    readonly ownerId: string;
    readonly orgId: string | null;
    readonly ownerIsAdmin: boolean;
}

export interface WantedCertificate {
    /** The base it covers, with `*.<domain>` beside it. */
    readonly domain: string;
    readonly source: "owner" | "hostname";
    /** The owner domain it is for or under - whose DNS token proves it. */
    readonly ownerDomainId: string | null;
}

/** Whether `domain` is `parent` or a name under it. */
function within(domain: string, parent: string): boolean {
    return domain === parent || domain.endsWith(`.${parent}`);
}

/** The certificates that should exist, one per base, owner domains first. */
export function plannedCertificates(input: {
    readonly ownerDomains: readonly OwnerDomainFacts[];
    readonly wildcardHosts: readonly WildcardHostFacts[];
    /** The operator's deploy base, whose wildcard has a service of its own. */
    readonly deployBase: string | null;
}): WantedCertificate[] {
    const wanted = new Map<string, WantedCertificate>();
    const deployBase = input.deployBase?.trim().toLowerCase() || null;
    const verified = input.ownerDomains.filter((entry) => entry.verified);
    for (const entry of verified) {
        if (entry.domain === deployBase) continue;
        wanted.set(entry.domain, { domain: entry.domain, source: "owner", ownerDomainId: entry.id });
    }
    for (const host of input.wildcardHosts) {
        const hostname = host.hostname.trim().toLowerCase();
        if (!hostname.startsWith("*.") || host.hasUpload) continue;
        const base = hostname.slice(2);
        if (!base.includes(".") || base === deployBase || wanted.has(base)) continue;
        // The closest verified owner domain the name is under, and whether it is
        // the service owner's own.
        const under = verified
            .filter((entry) => within(base, entry.domain))
            .sort((a, b) => b.domain.length - a.domain.length)[0];
        const theirs = under !== undefined && (host.orgId ? under.orgId === host.orgId : under.userId === host.ownerId);
        if (!theirs && !host.ownerIsAdmin) continue;
        wanted.set(base, { domain: base, source: "hostname", ownerDomainId: theirs ? under.id : null });
    }
    return [...wanted.values()];
}

export interface CertificateTiming {
    readonly certPem: string | null;
    readonly expiresAt: Date | null;
    readonly nextAttemptAt: Date | null;
}

/** Whether a certificate should be ordered now: never issued, or inside its
 *  renewal window - and not waiting out a failure. */
export function isDue(row: CertificateTiming, now: Date): boolean {
    if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime()) return false;
    if (!row.certPem || !row.expiresAt) return true;
    return row.expiresAt.getTime() - now.getTime() <= RENEW_BEFORE_MS;
}

/** How long to wait after the `failures`th failure in a row: doubling from a
 *  quarter of an hour, never more than a day - so a zone fixed later is noticed
 *  the same day, and one that keeps refusing costs one attempt a day. */
export function retryDelayMs(failures: number): number {
    const step = Math.max(0, failures - 1);
    return Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(step, 16));
}

/** Whether a certificate for `domain` (and its wildcard) covers a hostname. A
 *  wildcard covers exactly one label, so `a.b.example.com` is not under
 *  `*.example.com`. */
export function covers(domain: string, hostname: string): boolean {
    const name = hostname.toLowerCase();
    if (name === domain || name === `*.${domain}`) return true;
    if (!name.endsWith(`.${domain}`)) return false;
    return !name.slice(0, -(domain.length + 1)).includes(".");
}
