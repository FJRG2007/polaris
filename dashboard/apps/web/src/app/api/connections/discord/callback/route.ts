/**
 * Where Discord returns somebody after they authorize their account.
 *
 * A fixed path, because it is registered as a redirect URI on the operator's own
 * Discord application: Discord refuses an authorization that comes back anywhere
 * else, exact string match and no wildcards.
 */

import { finishConnectionCallback } from "@/lib/connections/link-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    return finishConnectionCallback(request, "discord");
}
