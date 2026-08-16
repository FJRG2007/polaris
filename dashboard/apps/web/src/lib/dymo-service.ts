/**
 * Dymo IP-fraud gate for outward-facing access (share links and drop points). When
 * the Dymo integration is enabled and configured to verify access IPs, the
 * visitor's IP is checked against the operator's deny rules. Fails open: a missing
 * integration, no key, no IP, or any API/network error all allow access, so a Dymo
 * outage never locks out legitimate visitors.
 *
 * The verdict is remembered per address, because this sits on a public URL: one
 * crawler working through a share link was one paid lookup per hit, for the same
 * address, all day. What is cached is the provider's answer about the address -
 * not the decision about the link - so a link's own rules still apply on every
 * visit.
 */

import { verifyIp } from "@/lib/integrations/dymo";
import { readDymoConfig } from "@/lib/integrations/registry";
import { rememberedVerdict, rememberVerdict } from "@/lib/address-reputation";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";

/** Whether a visitor IP is allowed by the Dymo integration (allow-on-error). */
export async function dymoIpAllowed(ip: string | undefined): Promise<{ allowed: boolean; reason?: string }> {
    if (!ip) return { allowed: true };
    const state = await getIntegrationState("dymo");
    if (!state?.enabled) return { allowed: true };
    const config = readDymoConfig(state.config);
    if (!config.verifyAccessIp || config.deny.length === 0) return { allowed: true };
    const apiKey = await getIntegrationSecret("dymo");
    if (!apiKey) return { allowed: true };

    const remembered = await rememberedVerdict(ip, "dymo", config.deny);
    if (remembered) {
        return remembered.allow
            ? { allowed: true }
            : { allowed: false, reason: remembered.reason ?? "flagged" };
    }

    try {
        const { allow, reasons } = await verifyIp(apiKey, ip, config.deny);
        // Written before the answer is used, so a visitor who reloads is not a
        // second lookup even if the first one turned them away.
        await rememberVerdict(ip, "dymo", config.deny, { allow, reason: reasons[0] ?? null });
        return allow ? { allowed: true } : { allowed: false, reason: reasons[0] ?? "flagged" };
    } catch {
        return { allowed: true };
    }
}
