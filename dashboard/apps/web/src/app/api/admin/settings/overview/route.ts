/**
 * The three slow answers the Settings page needs, in one request.
 *
 * The page used to await all of them before rendering a pixel, and each one goes
 * out to the network: the update check asks GitHub, the address list probes
 * every configured hostname, and the network status detects this box's public
 * address. On a cold cache that is the navigation itself held open for however
 * long the slowest takes, with nothing on screen to say why.
 *
 * One request rather than three, for the reason the domains overview is one: all
 * of it lands in the same render, and separate round trips would fill the update
 * line, then the addresses, then the IPs, each a frame apart.
 *
 * Admin-only. Node runtime for Prisma.
 */

import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";

import { getUpdateStatus } from "@/lib/update-service";
import { checkedAddresses } from "@/lib/address-health";
import { getNetworkStatus } from "@/lib/network-service";
import type { SettingsOverview } from "@/app/(app)/admin/settings/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    const [status, addresses, network] = await Promise.all([
        getUpdateStatus(),
        checkedAddresses(),
        getNetworkStatus()
    ]);
    const overview: SettingsOverview = {
        status,
        addresses,
        publicIp: network.publicIp,
        serverIp: network.subdomainIp
    };
    return NextResponse.json(overview);
}
