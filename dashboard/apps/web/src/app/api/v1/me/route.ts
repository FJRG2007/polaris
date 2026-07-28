/**
 * GET /api/v1/me - who an API key acts as, and what it may do.
 *
 * The smallest useful endpoint a key can call, and the one that answers "is my
 * key set up correctly" without the caller having to attempt a real operation
 * and guess at the failure. It requires no scope: holding a valid key is already
 * proof of the identity it reports.
 */

import { prisma } from "@polaris/db";
import { requireApiKey } from "@/lib/api-key-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const principal = await requireApiKey(request);
    if (principal instanceof Response) return principal;

    const user = await prisma.user.findUnique({
        where: { id: principal.userId },
        select: { id: true, name: true, email: true, username: true }
    });
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    return Response.json({
        user,
        key: { id: principal.keyId, scopes: principal.scopes }
    });
}
