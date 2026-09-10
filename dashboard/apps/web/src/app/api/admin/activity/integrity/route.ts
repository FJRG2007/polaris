/**
 * Where the audit trail's tamper-evident chain stands: how much is sealed, how
 * much is waiting to be, where retention last cut it, and what the last check
 * found. Read after the Activity screen paints. Admin-only; Node runtime.
 */

import { apiAdmin } from "@/lib/api-session";
import { auditChainStatus } from "@/lib/audit-chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    return Response.json(await auditChainStatus());
}
