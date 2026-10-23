/**
 * Who may read the network filter's statistics.
 *
 * Administrators, who run the filter, and anybody one of them shared it with
 * (`dns.filter`, a grant over the one filter there is). A grant reads the
 * long-term totals and the domains most asked for; which device asked, the live
 * log, the rules and the settings stay with administrators.
 */

import * as core from "@polaris/core";
import type { SessionUser } from "@/lib/session";
import { grantedCapability } from "@/lib/access/grants";
import type { DnsHistory } from "@/lib/dns-blocker/history";

/** How a viewer reaches the filter: as an administrator, through a share, or not. */
export type DnsFilterReach = "admin" | "shared" | null;

export async function dnsFilterReach(
    user: Pick<SessionUser, "id" | "isAdmin">
): Promise<DnsFilterReach> {
    if (user.isAdmin) return "admin";
    const held = await grantedCapability(user.id, "dns.filter", core.DNS_FILTER_ID);
    return core.atLeast("dns.filter", held, "view") ? "shared" : null;
}

/** The statistics as anybody but an administrator is sent them: nothing that
 *  names a device on the network. */
export function sharedDnsHistory(history: DnsHistory): DnsHistory {
    return { ...history, topClients: [], topBlockedClients: [], clientNames: [] };
}
