/**
 * One organization's statement for a month as a file.
 *
 * The same permission as reading it, `settings.manage`, because the file holds
 * nothing the screen does not; the export is recorded in the organization's own
 * history, so the people running it can see that a copy was taken. Node runtime
 * for Prisma.
 */

import { apiUser } from "@/lib/api-session";
import { orgReaderWith } from "@/lib/orgs/activity-access";
import { statementExportResponse } from "@/lib/billing/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ slug: string }> }
): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const { slug } = await params;
    const orgId = await orgReaderWith(user, slug, "settings.manage");
    if (!orgId) return new Response(null, { status: 404 });
    return statementExportResponse(
        request,
        { kind: "orgs", orgIds: [orgId] },
        { label: slug, actorId: user.id, orgId }
    );
}
