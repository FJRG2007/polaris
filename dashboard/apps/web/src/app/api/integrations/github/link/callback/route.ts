/**
 * Where GitHub returns somebody after they authorize their account.
 *
 * The path is under /api/integrations rather than with the other connection
 * routes because it is registered as a callback URL on the GitHub App created
 * for this instance. An app cannot learn a new one without somebody editing it,
 * so moving the path would break linking on every deployment that has already
 * connected. The flow behind it is the shared one.
 */

import { finishConnectionLink } from "@/lib/connections/link-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    return finishConnectionLink(request, "github");
}
