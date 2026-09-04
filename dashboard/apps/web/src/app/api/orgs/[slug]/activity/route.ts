/**
 * One organization's history, and the people who appear in it.
 *
 * A route rather than page data because the feed refreshes on its own and the
 * screen paints before it arrives - an audit query over a long-lived instance is
 * not something to hold a navigation open for.
 *
 * Narrowing is done here rather than by filtering rows already sent: the feed is
 * capped, and somebody whose entries have scrolled past the cap is exactly who a
 * reader is trying to isolate.
 */

import { hasOrgPermission } from "@polaris/core";
import { apiUser } from "@/lib/api-session";
import { orgIdForSlug, resolveOrgAccess } from "@/lib/orgs/org-service";
import { listOrgActivity, listOrgActivityActors } from "@/lib/audit-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const { slug } = await params;

    const orgId = await orgIdForSlug(slug.toLowerCase());
    if (!orgId) return new Response(null, { status: 404 });

    const access = await resolveOrgAccess({ id: user.id, isAdmin: user.isAdmin }, orgId);
    // An organization this account has no part in, and one whose history it may
    // not read, answer the same way. Neither is something to confirm the shape of.
    if (!access || !hasOrgPermission(access.permissions, "activity.read")) {
        return new Response(null, { status: 404 });
    }

    const actorId = new URL(request.url).searchParams.get("actor") ?? undefined;
    const [items, actors] = await Promise.all([
        listOrgActivity(orgId, { actorId: actorId || undefined }),
        listOrgActivityActors(orgId)
    ]);

    return Response.json({ items, actors });
}
