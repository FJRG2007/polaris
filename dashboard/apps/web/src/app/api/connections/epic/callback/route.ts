/**
 * Where Epic returns somebody after they authorize their account.
 *
 * A fixed path, because it is registered as a redirect URI on the operator's own
 * Epic product: Epic refuses an authorization that comes back anywhere else.
 */

import { finishConnectionCallback } from "@/lib/connections/link-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    return finishConnectionCallback(request, "epic");
}
