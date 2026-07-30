/**
 * Which of a service's hostnames is the one worth showing. Its own address has to
 * stay put across deploys - it is what people saved and linked - so the ranking is
 * about how stable a name is, not only how reachable it is. Pure, and apart from
 * the view because getting it wrong is what silently moves a service's address.
 */

/** A domain as carried on an app (the shape shared by the card and service detail). */
export interface AppDomain {
    id: string;
    hostname: string;
    kind: string;
    enabled: boolean;
    healthStatus?: string;
    healthCode?: number | null;
    healthDetail?: string | null;
}

/** Whether a domain resolves only on the local network (a LAN-only exposure). */
export function isLocalDomain(domain: AppDomain): boolean {
    return domain.kind === "lan" || domain.hostname.toLowerCase().endsWith(".local");
}

/**
 * Rank a domain by how stable and reachable it is: the operator's own custom
 * domain beats a named tunnel, which beats the free subdomain, which beats a
 * throwaway tunnel, which beats a LAN-only name. A disabled domain never wins.
 *
 * A quick/ngrok tunnel is publicly reachable even from behind NAT, so it still
 * outranks a name that only resolves on the LAN - but never the free subdomain,
 * because its hostname is minted afresh every time the tunnel starts. Letting it
 * win would change the service's address on every deploy, which is the one thing
 * an address must not do.
 *
 * A per-release hostname is never a candidate: it names one build rather than the
 * service, and it goes away when that build does.
 */
function domainRank(domain: AppDomain): number {
    if (!domain.enabled || domain.kind === "release") return -1;
    if (isLocalDomain(domain)) return 1;
    if (domain.kind === "tunnel-temp") return 2;
    if (domain.kind === "auto" || domain.hostname.toLowerCase().endsWith(".sslip.io")) return 3;
    if (domain.kind === "custom") return 5;
    return 4;
}

/** The best domain to surface for an app (most stable + reachable), or null. */
export function primaryDomain<T extends AppDomain>(domains: readonly T[]): T | null {
    let best: T | null = null;
    let bestRank = 0;
    for (const domain of domains) {
        const rank = domainRank(domain);
        if (rank > bestRank) {
            best = domain;
            bestRank = rank;
        }
    }
    return best;
}
