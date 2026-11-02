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

import { CRIMINALIP_RULES } from "@/lib/integrations/criminalip-rules";
import { whileServing } from "@/lib/integrations/provider-pause";

const ENDPOINT = "https://api.criminalip.io/v1/asset/ip/report/summary";

/** The scores Criminal IP returns, as the levels their API documents. Anything at
 *  "dangerous" or above is treated as malicious regardless of the boolean flags. */
const DANGEROUS_SCORES = new Set(["dangerous", "critical"]);

/**
 * Check an address. `allow` is false when it trips any of the chosen rules.
 *
 * Throws on a transport or API failure rather than guessing: the caller treats not
 * knowing as not blocking, and that decision belongs there, not here.
 */
export function checkCriminalIp(
    apiKey: string,
    ip: string,
    deny: readonly string[]
): Promise<{ allow: boolean; reasons: string[] }> {
    return whileServing("criminalip", "Criminal IP", () => askCriminalIp(apiKey, ip, deny));
}

async function askCriminalIp(
    apiKey: string,
    ip: string,
    deny: readonly string[]
): Promise<{ allow: boolean; reasons: string[] }> {
    const response = await fetch(`${ENDPOINT}?ip=${encodeURIComponent(ip)}`, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
        throw Object.assign(new Error(`Criminal IP responded ${response.status}`), {
            status: response.status
        });
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object")
        throw new Error("Criminal IP returned an unreadable body");

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
