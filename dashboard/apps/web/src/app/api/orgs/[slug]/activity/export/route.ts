/**
 * One organization's history as a file - members joining and leaving, roles
 * changed, work created and removed - narrowed the way the screen is.
 *
 * The same permission as reading it, `activity.read`, because the file holds
 * nothing the screen does not; the export is recorded in the organization's own
 * history, so its people can see that a copy was taken. Node runtime for Prisma.
 */

import { apiUser } from "@/lib/api-session";
import { auditExportResponse } from "@/lib/audit-routes";
import { orgActivityReader } from "@/lib/orgs/activity-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const { slug } = await params;
    const orgId = await orgActivityReader(user, slug);
    if (!orgId) return new Response(null, { status: 404 });
    return auditExportResponse(request, { kind: "org", orgId }, { label: slug, actorId: user.id, orgId });
}
