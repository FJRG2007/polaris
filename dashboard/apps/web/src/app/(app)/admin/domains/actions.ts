"use server";

/**
 * Domain-settings admin actions. Admin-gated: these change the URLs Polaris hands
 * out for shares and drop points, and hold the DuckDNS token. The token is
 * tri-state (a value sets it, blank keeps it); a separate action clears it.
 */

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
    detectPublicIp,
    getNetworkStatus,
    setNetworkConfig,
    type NetworkMode,
    type NetworkStatus
} from "@/lib/network-service";
import { recordAudit } from "@/lib/audit-service";

export async function saveDomainsAction(input: {
    appDomain: string;
    sharingDomain: string;
    duckdnsSubdomain: string;
    duckdnsToken?: string;
}): Promise<{ config: DomainConfig }> {
    const user = await requireAdmin();
    await setDomainConfig(input);
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

/** Current network topology + exposure mode (re-detecting the public IP if asked). */
export async function networkStatusAction(redetect = false): Promise<NetworkStatus> {
    await requireAdmin();
    if (redetect) await detectPublicIp(true);
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
