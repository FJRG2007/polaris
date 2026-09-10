/**
 * The whole deployment's audit trail as a file, narrowed the way the screen is.
 *
 * Admin-only, streamed, and itself recorded in the trail. CSV for a spreadsheet,
 * JSON for anything that will read it back - the JSON opens with the chain's head,
 * which is the value to keep elsewhere. Node runtime for Prisma.
 */

import { apiAdmin } from "@/lib/api-session";
import { auditExportResponse } from "@/lib/audit-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    return auditExportResponse(request, { kind: "all" }, { label: "polaris", actorId: user.id });
}
