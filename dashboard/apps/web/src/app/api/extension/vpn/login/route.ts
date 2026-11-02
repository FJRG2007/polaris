/** POST a node for an hour's login to its browser proxy. */

import { extensionUser } from "@/lib/vpn/extension-user";
import { browserLoginForClient } from "@/lib/vpn/client-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const userId = await extensionUser(request);
    if (!userId) return Response.json({ error: "connection-ended" }, { status: 401 });
    return browserLoginForClient(userId, request);
}
