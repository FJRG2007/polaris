/**
 * Criminal IP reputation lookup, over their plain REST endpoint.
 *
 * One call, one verdict, deliberately no SDK: the whole surface Polaris needs is a
 * yes/no about an address plus a reason to show, and a dependency for that would be
 * one more thing to keep current. Kept isolated for the same reason the Dymo wrapper
 * is - the firewall depends on a plain result shape, not on a vendor's.
 *
 * Never used on the request path. The firewall asks about addresses it has already
 * seen in the access log, out of band, and caches the answer as an ordinary ban.
 */

const ENDPOINT = "https://api.criminalip.io/v1/asset/ip/report/summary";

/** What Criminal IP reports that Polaris will act on. Each maps to a boolean their
 *  summary returns; an operator picks which ones count as a block. */
export const CRIMINALIP_RULES = [
    { value: "is_vpn", label: "VPN" },
    { value: "is_proxy", label: "Proxy" },
    { value: "is_tor", label: "Tor" },
    { value: "is_hosting", label: "Hosting or datacenter" },
    { value: "is_scanner", label: "Known scanner" },
    { value: "is_malicious", label: "Known malicious" }
] as const;

export type CriminalIpRule = (typeof CRIMINALIP_RULES)[number]["value"];

/** The scores Criminal IP returns, as the levels their API documents. Anything at
 *  "dangerous" or above is treated as malicious regardless of the boolean flags. */
const DANGEROUS_SCORES = new Set(["dangerous", "critical"]);

/**
 * Check an address. `allow` is false when it trips any of the chosen rules.
 *
 * Throws on a transport or API failure rather than guessing: the caller treats not
 * knowing as not blocking, and that decision belongs there, not here.
 */
export async function checkCriminalIp(
    apiKey: string,
    ip: string,
    deny: readonly string[]
): Promise<{ allow: boolean; reasons: string[] }> {
    const response = await fetch(`${ENDPOINT}?ip=${encodeURIComponent(ip)}`, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Criminal IP responded ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") throw new Error("Criminal IP returned an unreadable body");

    const report = body as Record<string, unknown>;
    const reasons: string[] = [];
    for (const rule of CRIMINALIP_RULES) {
        if (!deny.includes(rule.value)) continue;
        if (report[rule.value] === true) reasons.push(rule.label);
    }
    const score = report.score;
    if (deny.includes("is_malicious") && score && typeof score === "object") {
        const inbound = String((score as Record<string, unknown>).inbound ?? "").toLowerCase();
        if (DANGEROUS_SCORES.has(inbound)) reasons.push(`Inbound score ${inbound}`);
    }
    return { allow: reasons.length === 0, reasons };
}

export interface CriminalIpConfig {
    readonly deny: CriminalIpRule[];
}

/** Blocking a datacenter or a VPN blocks a lot of ordinary people, so the defaults
 *  are the two that do not: an address seen scanning, and one already known bad. */
const CRIMINALIP_DEFAULTS: CriminalIpConfig = { deny: ["is_scanner", "is_malicious"] };

export function readCriminalIpConfig(config: Record<string, unknown> | undefined): CriminalIpConfig {
    const valid = new Set<string>(CRIMINALIP_RULES.map((rule) => rule.value));
    const raw = Array.isArray(config?.deny) ? (config?.deny as unknown[]) : [];
    const deny = raw.filter((value): value is CriminalIpRule => typeof value === "string" && valid.has(value));
    return { deny: deny.length > 0 ? deny : CRIMINALIP_DEFAULTS.deny };
}
