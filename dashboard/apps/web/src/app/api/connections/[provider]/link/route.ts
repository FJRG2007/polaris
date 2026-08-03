/**
 * Start linking the signed-in account to an outside one. The provider decides
 * where this goes; the flow is the same for all of them.
 */

import { startConnectionLink } from "@/lib/connections/link-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }): Promise<Response> {
    const { provider } = await context.params;
    return startConnectionLink(request, provider);
}
