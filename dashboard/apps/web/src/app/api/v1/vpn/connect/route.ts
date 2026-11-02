/** GET the nodes this key's owner may use; POST to connect a device of theirs. */

import { requireApiKey } from "@/lib/api-key-auth";
import { withKeyUsage } from "@/lib/api-usage/recorder";
import { connectForClient, listForClient } from "@/lib/vpn/client-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withKeyUsage(async (request: Request): Promise<Response> => {
    const principal = await requireApiKey(request, "vpn.use");
    if (principal instanceof Response) return principal;
    return listForClient(principal.userId);
});

export const POST = withKeyUsage(async (request: Request): Promise<Response> => {
    const principal = await requireApiKey(request, "vpn.use");
    if (principal instanceof Response) return principal;
    return connectForClient(principal.userId, request);
});
