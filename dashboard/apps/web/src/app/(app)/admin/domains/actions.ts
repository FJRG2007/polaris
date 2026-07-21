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
import { getTunnelStatus, setTunnelConfig, type TunnelProvider, type TunnelStatus } from "@/lib/tunnel-service";
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

/** Configure the outbound tunnel (Cloudflare/ngrok) that exposes apps without a
 *  port-forward. The token is tri-state (a value sets it, blank keeps it). */
export async function saveTunnelAction(input: {
    provider: TunnelProvider;
    token?: string;
}): Promise<{ status: TunnelStatus; error?: string }> {
    const user = await requireAdmin();
    try {
        await setTunnelConfig(input);
        await recordAudit({ actorId: user.id, action: "tunnel.configure", targetType: "setting", targetId: "tunnel" });
        revalidatePath("/admin/domains");
        return { status: await getTunnelStatus() };
    } catch (caught) {
        return {
            status: await getTunnelStatus(),
            error: caught instanceof Error ? caught.message : "Could not apply the tunnel configuration"
        };
    }
}
