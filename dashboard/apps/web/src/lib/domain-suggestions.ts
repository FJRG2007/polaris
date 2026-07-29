/**
 * The addresses Polaris should propose for itself, derived from the zone layout the
 * operator already configured. Both are suggestions, never writes: the fields they
 * fill are stored settings an operator may deliberately point elsewhere.
 *
 * The point is that the answer is already known by the time the fields are read. An
 * operator who has just pointed `polaris.example.com` at this server should not be
 * asked to type it again next to a placeholder reading `polaris.example.com` - the
 * generic example is indistinguishable from the real answer, which is exactly why it
 * reads as one.
 *
 * Pure and free of server imports so the panel can use it directly.
 */

import type { DomainZoneConfig } from "./domain-zones";

export interface DomainSuggestions {
    /** Where the dashboard should answer. */
    app: string | null;
    /** Where share links and drop points should be handed out from. */
    sharing: string | null;
}

/** A zone's own hostname. An empty label means the base domain itself. */
export function zoneHost(baseDomain: string, label: string): string {
    const base = baseDomain.trim();
    const prefix = label.trim();
    if (!base) return "";
    return prefix ? `${prefix}.${base}` : base;
}

/**
 * What to propose for Polaris's own addresses, or nulls when no zone can answer.
 *
 * The sharing name is a subdomain of the Polaris zone rather than of the base domain,
 * because the zone's wildcard record already answers for it. Proposing
 * `share.example.com` instead would look equally reasonable and need a DNS record
 * that does not exist.
 */
export function domainSuggestions(config: DomainZoneConfig): DomainSuggestions {
    const scoped = config.zones.filter((zone) => zone.scope === "polaris");
    const zone = scoped.find((entry) => entry.primary) ?? scoped[0];
    if (!zone) return { app: null, sharing: null };
    const host = zoneHost(config.baseDomain, zone.label);
    if (!host) return { app: null, sharing: null };
    return { app: host, sharing: `share.${host}` };
}
