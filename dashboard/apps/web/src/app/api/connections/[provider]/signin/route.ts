/**
 * Start signing in with an outside account somebody has already linked.
 *
 * Open to anybody signed out, which is the point of it, so everything that
 * decides whether it may happen lives in the flow: whether the operator allows
 * this service as a way in, and how often one address may ask. It comes back
 * through the same callback a link does.
 */

import { startConnectionSignIn } from "@/lib/connections/link-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }): Promise<Response> {
    const { provider } = await context.params;
    return startConnectionSignIn(request, provider);
}
