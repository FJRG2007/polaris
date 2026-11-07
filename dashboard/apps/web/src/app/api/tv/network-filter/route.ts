/**
 * GET /api/tv/network-filter - what a connected TV needs to send its lookups to
 * the network filter over encrypted DNS (Android's Private DNS, strict mode):
 * the hostname to set, and whether the filter answers it now. `available` is
 * true only when the filter runs, serves encrypted DNS, and something answers
 * port 853 on its address, so a TV never sets a name that would cut it off.
 * It reads nothing from the request but the key.
 */

import { tvCaller } from "@/lib/tv/auth";
import { getHostLanIp } from "@/lib/host-address";
import { withKeyUsage } from "@/lib/api-usage/recorder";
import { encryptedDnsStatus, engineRow, readSettings } from "@/lib/dns-blocker/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withKeyUsage(async (request: Request): Promise<Response> => {
    const caller = await tvCaller(request);
    if (caller instanceof Response) return caller;
    const [settings, engine, address] = await Promise.all([
        readSettings(),
        engineRow(),
        getHostLanIp().catch(() => null)
    ]);
    const running = engine?.status === "running";
    const dot = running ? await encryptedDnsStatus(settings, address, engine) : null;
    const available = Boolean(dot?.enabled && dot.hostname && !dot.blocker && dot.listening);
    return Response.json(
        {
            available,
            dotHostname: available ? (dot?.hostname ?? null) : null,
            lanAddress: running ? address : null
        },
        { headers: { "cache-control": "no-store" } }
    );
});
