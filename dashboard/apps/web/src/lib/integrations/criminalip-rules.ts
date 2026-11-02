/**
 * The verdicts an operator can choose from for Criminal IP. Apart from the client in
 * `criminalip.ts` because the integrations screen renders them in the browser, and
 * the client reaches the database through the paid-request gate.
 */

/** What Criminal IP reports that Polaris will act on. Each maps to a boolean their
 *  summary returns; an operator picks which ones count as a block. */
export const CRIMINALIP_RULES = [
    // i18n-ignore the integrations screen says it by value
    { value: "is_vpn", label: "VPN" },
    // i18n-ignore the integrations screen says it by value
    { value: "is_proxy", label: "Proxy" },
    // i18n-ignore the integrations screen says it by value
    { value: "is_tor", label: "Tor" },
    // i18n-ignore the integrations screen says it by value
    { value: "is_hosting", label: "Hosting or datacenter" },
    // i18n-ignore the integrations screen says it by value
    { value: "is_scanner", label: "Known scanner" },
    // i18n-ignore the integrations screen says it by value
    { value: "is_malicious", label: "Known malicious" }
] as const;

export type CriminalIpRule = (typeof CRIMINALIP_RULES)[number]["value"];

export interface CriminalIpConfig {
    readonly deny: CriminalIpRule[];
}

/** Blocking a datacenter or a VPN blocks a lot of ordinary people, so the defaults
 *  are the two that do not: an address seen scanning, and one already known bad. */
const CRIMINALIP_DEFAULTS: CriminalIpConfig = { deny: ["is_scanner", "is_malicious"] };

export function readCriminalIpConfig(
    config: Record<string, unknown> | undefined
): CriminalIpConfig {
    const valid = new Set<string>(CRIMINALIP_RULES.map((rule) => rule.value));
    const raw = Array.isArray(config?.deny) ? (config?.deny as unknown[]) : [];
    const deny = raw.filter(
        (value): value is CriminalIpRule => typeof value === "string" && valid.has(value)
    );
    return { deny: deny.length > 0 ? deny : CRIMINALIP_DEFAULTS.deny };
}
