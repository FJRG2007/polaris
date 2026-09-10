/**
 * The whole instance's statement for a month as a file.
 *
 * Admin-only, and recorded in the audit trail like every other copy taken out of
 * Polaris. CSV is a row per project; JSON is the whole statement. Node runtime for
 * Prisma.
 */

import { apiAdmin } from "@/lib/api-session";
import { statementExportResponse } from "@/lib/billing/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    return statementExportResponse(request, { kind: "all" }, { label: "polaris", actorId: user.id });
}
