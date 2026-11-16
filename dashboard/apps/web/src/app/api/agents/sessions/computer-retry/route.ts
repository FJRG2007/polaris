// Try again for a computer whose tools could not be prepared. A route rather
// than an imported action so the session screen's boot line stays a plain
// client module.
import { z } from "zod";
import { retryComputerToolchainAction } from "@/components/agents/sessions/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ sessionId: z.string().trim().uuid() });

export async function POST(request: Request): Promise<Response> {
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    return Response.json(await retryComputerToolchainAction(body.data.sessionId));
}
