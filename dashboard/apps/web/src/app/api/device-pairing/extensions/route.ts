/**
 * The browser ids of the signed-in account's extensions, which Polaris Desktop
 * writes into its native messaging host's manifest so exactly those extensions
 * may reach it (`lib/device-sessions/device-pairing`).
 */

import { apiUser } from "@/lib/api-session";
import { pairingExtensionIds } from "@/lib/device-sessions/device-pairing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (user.viewingAs) return Response.json({ runtimeIds: [] });
    return Response.json({ runtimeIds: await pairingExtensionIds(user.id) }, { headers: { "Cache-Control": "no-store" } });
}
