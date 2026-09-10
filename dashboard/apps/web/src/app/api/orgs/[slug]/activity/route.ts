/**
 * One organization's history, a page at a time.
 *
 * A route rather than page data because the feed refreshes on its own and the
 * screen paints before it arrives - an audit query over a long-lived instance is
 * not something to hold a navigation open for.
 *
 * Narrowing is done here rather than by filtering rows already sent: the feed is
 * paged, and somebody whose entries are pages back is exactly who a reader is
 * trying to isolate. The scope is the organization and nothing a parameter says
 * can widen it.
 */

import { apiUser } from "@/lib/api-session";
import { auditPageResponse } from "@/lib/audit-routes";
import { orgActivityReader } from "@/lib/orgs/activity-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ slug: string }> }
): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const orgId = await orgActivityReader(user, (await params).slug);
    // An organization this account has no part in, and one whose history it may
    // not read, answer the same way. Neither is something to confirm the shape of.
    if (!orgId) return new Response(null, { status: 404 });
    return auditPageResponse(request, { kind: "org", orgId });
}
