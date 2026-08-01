"use server";

/**
 * Domain-settings admin actions. Admin-gated: these change the URLs Polaris hands
 * out for shares and drop points, and hold the DuckDNS token. The token is
 * tri-state (a value sets it, blank keeps it); a separate action clears it.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { checkedAddresses, removeAddress, type CheckedAddress } from "@/lib/address-health";
import {
    clearDuckdnsToken,
    getDomainConfig,
    setDomainConfig,
    setExtraDomains,
    syncDuckDns,
    type DomainConfig
} from "@/lib/domain-service";
import {
    detectPlacement,
    detectPublicIp,
    getNetworkStatus,
    setNetworkConfig,
    MODES,
    type NetworkMode,
    type NetworkStatus
} from "@/lib/network-service";

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
 *
 * Typed from the schema as well as parsed against it: every field being optional means
 * a mistyped key is stripped in silence, so a caller that sends `duckdnsTokn` would be
 * told the settings were saved while the token never reached the database.
 */
export async function saveDomainsAction(input: z.input<typeof domainsSchema>): Promise<{ config: DomainConfig }> {
    const user = await requireAdmin();
    const parsed = domainsSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid domain settings");
    await setDomainConfig(parsed.data);
    await recordAudit({ actorId: user.id, action: "domains.configure", targetType: "setting", targetId: "domains" });
    revalidatePath("/admin/domains");
    return { config: await getDomainConfig() };
}

/** At most this many names in one save, so a pasted document cannot become a router
 *  rule. The service caps the stored list as well; this only keeps the payload sane. */
const extraDomainsSchema = z.array(z.string().max(253)).max(64);

/**
 * Replace the extra hostnames the dashboard answers on. The list is saved whole
 * rather than one entry at a time: it is stored as one value and published to the
 * edge as one rule, so a per-entry action would only be two round trips to the same
 * write. Anything that is not a public hostname is dropped by the service, and what
 * it stored comes back - so the page shows what is in force, not what was typed.
 */
export async function saveExtraDomainsAction(input: unknown): Promise<{ config: DomainConfig }> {
    const user = await requireAdmin();
    const parsed = extraDomainsSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid domain list");
    await setExtraDomains(parsed.data);
    await recordAudit({ actorId: user.id, action: "domains.configure", targetType: "setting", targetId: "domains" });
    revalidatePath("/admin/domains");
    return { config: await getDomainConfig() };
}

/** The deployment's addresses with the last health sweep's result. */
export async function deploymentAddressesAction(): Promise<CheckedAddress[]> {
    await requireAdmin();
    return checkedAddresses();
}

/** What went wrong when an address could not be taken off the list, in the words the
 *  page shows. Each case is a different thing to do next, so none of them is "failed". */
const REMOVAL_ERRORS: Record<string, string> = {
    unknown: "That address is no longer listed.",
    "built-in": "This is the address the deployment was installed with. It changes with the installation, not here.",
    managed: "This name comes from the guided setup above. Change the zone layout there to stop using it."
};

/**
 * Stop listing an address: tear a tunnel down, or clear a configured domain from
 * wherever it was set. Admin-only - both change where Polaris answers. Returns the
 * list as it now stands, so a page never has to predict what the removal left.
 */
export async function removeAddressAction(host: unknown): Promise<{ addresses: CheckedAddress[]; error?: string }> {
    const user = await requireAdmin();
    if (typeof host !== "string" || !host.trim()) {
        return { addresses: await checkedAddresses(), error: "No address given." };
    }
    const result = await removeAddress(host);
    if (result === "removed") {
        await recordAudit({ actorId: user.id, action: "domains.remove", targetType: "setting", targetId: host });
        revalidatePath("/admin/domains");
    }
    return { addresses: await checkedAddresses(), error: REMOVAL_ERRORS[result] };
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

/**
 * The exposure mode is checked again downstream, but the wildcard domain is not: it is
 * stored as given and then interpolated into the hostnames Polaris mints and asks
 * Let's Encrypt to certify, so a non-string reaching `.trim()` is a 500 and a
 * kilobyte-long one is a certificate request nobody can explain.
 */
const networkSchema = z.object({
    mode: z.enum(MODES as [NetworkMode, ...NetworkMode[]]).optional(),
    wildcardDomain: z.string().max(253).optional()
});

export async function saveNetworkConfigAction(input: z.input<typeof networkSchema>): Promise<NetworkStatus> {
    const user = await requireAdmin();
    const parsed = networkSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid network settings");
    await setNetworkConfig(parsed.data);
    await recordAudit({ actorId: user.id, action: "network.configure", targetType: "setting", targetId: "network" });
    revalidatePath("/admin/domains");
    return getNetworkStatus();
}
