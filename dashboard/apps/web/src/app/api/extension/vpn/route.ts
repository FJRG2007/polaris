/** GET the VPN nodes the extension's account may use. */

import { extensionUser } from "@/lib/vpn/extension-user";
import { listForClient } from "@/lib/vpn/client-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const userId = await extensionUser(request);
    if (!userId) return Response.json({ error: "connection-ended" }, { status: 401 });
    return listForClient(userId);
}
