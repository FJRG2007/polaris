"use server";

/**
 * Domain-settings admin actions. Admin-gated: these change the URLs Polaris hands
 * out for shares and drop points, and hold the DuckDNS token. The token is
 * tri-state (a value sets it, blank keeps it); a separate action clears it.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import {
    clearDuckdnsToken,
    getDomainConfig,
    setDomainConfig,
    syncDuckDns,
    type DomainConfig
} from "@/lib/domain-service";
import {
    detectPlacement,
    detectPublicIp,
    getNetworkStatus,
    setNetworkConfig,
    type NetworkMode,
    type NetworkStatus
} from "@/lib/network-service";
import { recordAudit } from "@/lib/audit-service";

/**
 * The four settings this page edits, and nothing else. `setDomainConfig` also writes the
 * deploy base and the stored public IP, which every auto hostname is built from - an
 * action is reachable with any payload, so parsing is what keeps those two out of its
 * reach and what stops a non-string reaching `.trim()` as a 500.
 */
const domainsSchema = z.object({
    appDomain: z.string().optional(),
    sharingDomain: z.string().optional(),
    duckdnsSubdomain: z.string().optional(),
    duckdnsToken: z.string().optional()
});

/**
 * Save whichever domain settings were passed. Partial on purpose: the page saves the
 * app/sharing pair and the DuckDNS pair from separate panels, and a call that carried
 * the whole shape would have each one write back its stale copy of the other's fields.
 */
export async function saveDomainsAction(input: unknown): Promise<{ config: DomainConfig }> {
    const user = await requireAdmin();
    const parsed = domainsSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid domain settings");
    await setDomainConfig(parsed.data);
    await recordAudit({ actorId: user.id, action: "domains.configure", targetType: "setting", targetId: "domains" });
    revalidatePath("/admin/domains");
    return { config: await getDomainConfig() };
}

export async function clearDuckdnsTokenAction(): Promise<{ config: DomainConfig }> {
    await requireAdmin();
    await clearDuckdnsToken();
    revalidatePath("/admin/domains");
    return { config: await getDomainConfig() };
}

export async function syncDuckDnsAction(): Promise<{ ok: boolean; detail: string }> {
    await requireAdmin();
    return syncDuckDns();
}

/** Current network topology + exposure mode. Re-detecting refreshes the public IP
 *  and the hosting classification with it - a box that moved networks would keep
 *  reporting the old placement otherwise, and this button is the only way to force it. */
export async function networkStatusAction(redetect = false): Promise<NetworkStatus> {
    await requireAdmin();
    if (redetect) {
        await detectPublicIp(true);
        await detectPlacement(true);
    }
    return getNetworkStatus();
}

export async function saveNetworkConfigAction(input: {
    mode?: NetworkMode;
    wildcardDomain?: string;
}): Promise<NetworkStatus> {
    const user = await requireAdmin();
    await setNetworkConfig(input);
    await recordAudit({ actorId: user.id, action: "network.configure", targetType: "setting", targetId: "network" });
    revalidatePath("/admin/domains");
    return getNetworkStatus();
}
