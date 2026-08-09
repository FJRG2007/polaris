/**
 * Everything the domains panel needs before it can draw, in one request.
 *
 * One route rather than five reads in the page. The page awaited all of them
 * before rendering a single pixel, and one of them - the address list - dials the
 * tunnel daemon and probes every configured hostname, so opening /admin/domains
 * held the navigation itself open for as long as the slowest of those took. Now
 * the shell paints and this fills it in.
 *
 * One request rather than five, for the same reason the console's overview is
 * one: all of it lands in the same render, and separate round trips would paint
 * the fields, then the addresses, then the policy, each a frame apart.
 *
 * Admin-only. Node runtime for Prisma.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { getDomainZones } from "@/lib/domain-zones";
import { ownerDomainPolicy } from "@/lib/owner-domains";
import { checkedAddresses } from "@/lib/address-health";
import { appBaseUrl, getDomainConfig } from "@/lib/domain-service";
import type { DomainsOverview } from "@/app/(app)/admin/domains/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    await requireAdmin();
    const [config, effectiveAppUrl, zones, addresses, ownerPolicy] = await Promise.all([
        getDomainConfig(),
        appBaseUrl(),
        getDomainZones(),
        checkedAddresses(),
        ownerDomainPolicy()
    ]);
    const overview: DomainsOverview = { config, zones, addresses, effectiveAppUrl, ownerPolicy };
    return NextResponse.json(overview);
}
