/**
 * The admin activity feed, read after the screen has painted.
 *
 * The Activity screen renders its chrome immediately and asks for the rows from
 * here, so a navigation never waits on the audit query. Admin-only: the log
 * carries every actor and target across the deployment. Paged by cursor and
 * narrowed by who, what area, what kind of thing, a phrase and a time range -
 * see `lib/audit-query`. Node runtime for Prisma.
 */

import { apiAdmin } from "@/lib/api-session";
import { auditPageResponse } from "@/lib/audit-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    return auditPageResponse(request, { kind: "all" });
}
