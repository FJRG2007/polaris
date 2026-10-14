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
 * Each part answers on its own clock: one that throws or takes longer than
 * `PART_TIMEOUT_MS` comes back null instead of holding the other two, so one
 * slow probe never leaves the whole page on placeholders.
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

/** Well inside the page's own wait, so a slow part arrives as null, not as a
 *  request the page gave up on. */
const PART_TIMEOUT_MS = 12_000;

/** A part's answer, or null when it failed or ran past `PART_TIMEOUT_MS`. */
async function within<T>(work: Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PART_TIMEOUT_MS);
    });
    try {
        return await Promise.race([work.catch(() => null), late]);
    } finally {
        clearTimeout(timer);
    }
}

export async function GET(): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    const [status, addresses, network] = await Promise.all([
        within(getUpdateStatus()),
        within(checkedAddresses()),
        within(getNetworkStatus())
    ]);
    const overview: SettingsOverview = {
        status,
        addresses,
        network: network ? { publicIp: network.publicIp, serverIp: network.subdomainIp } : null
    };
    return NextResponse.json(overview);
}
