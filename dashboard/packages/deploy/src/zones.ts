/**
 * Domain zones: the wildcard subdomains Polaris mints hostnames under. A zone is a
 * DNS label below the operator's base domain ("plr" -> `*.plr.example.com`), or the
 * empty label to use the base domain itself (`*.example.com`). Polaris keeps one
 * zone for its own services and one or more for deployed ones, so a single wildcard
 * DNS record per zone covers every hostname it will ever hand out - no per-service
 * DNS work, which is what makes the layout scale. Pure.
 */

import { randomBytes } from "node:crypto";
import { magicDomain } from "./subdomain.js";

/** What a zone's hostnames are for: the Polaris control plane, or deployed services. */
export type ZoneScope = "polaris" | "deploy";

export interface DomainZone {
    /** DNS label under the base domain; empty means the base domain itself. */
    readonly label: string;
    readonly scope: ZoneScope;
    /** The zone new hostnames of this scope are minted under. */
    readonly primary: boolean;
}

/** Defaults Polaris asks for: the dashboard on `polaris.<base>`, services on `*.plr.<base>`. */
export const POLARIS_ZONE_LABEL = "polaris";
export const DEPLOY_ZONE_LABEL = "plr";

/** One DNS label: letters, digits and inner dashes, 63 chars max (RFC 1035). */
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A registrable domain: two or more labels, no wildcard, no scheme. */
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The zone layout offered out of the box. */
export function defaultZones(): DomainZone[] {
    return [
        { label: POLARIS_ZONE_LABEL, scope: "polaris", primary: true },
        { label: DEPLOY_ZONE_LABEL, scope: "deploy", primary: true }
    ];
}

/** Strip scheme, wildcard prefix, port, path and case from a typed base domain. */
export function normalizeBaseDomain(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^\*\./, "")
        .replace(/\/.*$/, "")
        .replace(/:\d+$/, "")
        .replace(/\.+$/, "");
}

/** Whether a normalized base domain is usable as a zone parent. */
export function isBaseDomain(value: string): boolean {
    return DOMAIN_PATTERN.test(value);
}

/** Whether a label is a valid zone label ("" is valid: the base domain itself). */
export function isZoneLabel(value: string): boolean {
    return value === "" || LABEL_PATTERN.test(value);
}

/** The zone's own hostname: `plr.example.com`, or the base domain for the empty label. */
export function zoneHost(zone: Pick<DomainZone, "label">, base: string): string {
    const domain = normalizeBaseDomain(base);
    return zone.label ? `${zone.label}.${domain}` : domain;
}

/** The single wildcard DNS record that covers every hostname in the zone. */
export function zoneWildcard(zone: Pick<DomainZone, "label">, base: string): string {
    return `*.${zoneHost(zone, base)}`;
}

/**
 * Deterministic hostname for a named service inside a zone, so redeploying the same
 * service keeps its URL. Same shape as the free sslip.io names (`<slug>-<hash>`),
 * with the zone as the base.
 */
export function zoneHostname(name: string, zone: Pick<DomainZone, "label">, base: string): string {
    return magicDomain(name, "", zoneHost(zone, base));
}

/** A random DNS label, for throwaway or unguessable hostnames. */
export function randomLabel(bytes = 5): string {
    return randomBytes(Math.max(1, bytes)).toString("hex");
}

/** An unguessable hostname in the zone (share links, previews, throwaway exposure). */
export function randomZoneHostname(zone: Pick<DomainZone, "label">, base: string, label = randomLabel()): string {
    return `${label}.${zoneHost(zone, base)}`;
}

/**
 * The zone a new hostname of `scope` belongs in: the one explicitly asked for by
 * label, else the scope's primary, else its first zone. Null when the scope has
 * none - the caller then falls back to a free subdomain.
 */
export function pickZone(zones: readonly DomainZone[], scope: ZoneScope, label?: string): DomainZone | null {
    const scoped = zones.filter((zone) => zone.scope === scope);
    if (label !== undefined) return scoped.find((zone) => zone.label === label) ?? null;
    return scoped.find((zone) => zone.primary) ?? scoped[0] ?? null;
}
