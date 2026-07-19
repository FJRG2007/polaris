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
