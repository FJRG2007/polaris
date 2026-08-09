/**
 * Where Microsoft returns somebody after they authorize their account.
 *
 * A fixed path rather than a dynamic one, because it is registered as a redirect
 * URI on the operator's Entra application: Microsoft refuses anything it was not
 * told about in advance.
 */

import { finishConnectionCallback } from "@/lib/connections/link-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    return finishConnectionCallback(request, "microsoft");
}
