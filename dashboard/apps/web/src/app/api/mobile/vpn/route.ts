/**
 * The phone app's VPN, as the signed-in session (`vpn.use`): GET the places this
 * person may use, POST to connect this phone to one with the public half of a
 * key the app made. The Quick Settings tile asks here before it reconnects, so
 * access that ended is said so instead of a tunnel that never answers.
 */

import { apiPermission } from "@/lib/api-session";
import { rateLimit } from "@/lib/rate-limit-service";
import { connectForClient, listForClient } from "@/lib/vpn/client-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiPermission("vpn.use");
    if (user instanceof Response) return user;
    return listForClient(user.id);
}

export async function POST(request: Request): Promise<Response> {
    const user = await apiPermission("vpn.use");
    if (user instanceof Response) return user;
    const allowed = await rateLimit(`mobile-vpn:${user.id}`, 20, 60_000);
    if (!allowed.ok) return Response.json({ error: "tooMany" }, { status: 429 });
    return connectForClient(user.id, request);
}
