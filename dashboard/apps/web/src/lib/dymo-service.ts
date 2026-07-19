/**
 * Dymo IP-fraud gate for outward-facing access (share links and drop points). When
 * the Dymo integration is enabled and configured to verify access IPs, the
 * visitor's IP is checked against the operator's deny rules. Fails open: a missing
 * integration, no key, no IP, or any API/network error all allow access, so a Dymo
 * outage never locks out legitimate visitors.
 */

import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";
import { readDymoConfig } from "@/lib/integrations/registry";
import { verifyIp } from "@/lib/integrations/dymo";

/** Whether a visitor IP is allowed by the Dymo integration (allow-on-error). */
export async function dymoIpAllowed(ip: string | undefined): Promise<{ allowed: boolean; reason?: string }> {
    if (!ip) return { allowed: true };
    const state = await getIntegrationState("dymo");
    if (!state?.enabled) return { allowed: true };
    const config = readDymoConfig(state.config);
    if (!config.verifyAccessIp || config.deny.length === 0) return { allowed: true };
    const apiKey = await getIntegrationSecret("dymo");
    if (!apiKey) return { allowed: true };
    try {
        const { allow, reasons } = await verifyIp(apiKey, ip, config.deny);
        return allow ? { allowed: true } : { allowed: false, reason: reasons[0] ?? "flagged" };
    } catch {
        return { allowed: true };
    }
}
