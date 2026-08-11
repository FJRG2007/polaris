/**
 * Where Steam returns somebody after they have proved their account.
 *
 * Unlike the OAuth callbacks beside it, nothing here was registered anywhere:
 * Steam returns to whatever `return_to` it was given, and signs that URL as part
 * of the assertion. The path is fixed anyway, so the address somebody comes back
 * on is the one this deployment publishes rather than one an attacker chose.
 */

import { finishConnectionCallback } from "@/lib/connections/link-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    return finishConnectionCallback(request, "steam");
}
