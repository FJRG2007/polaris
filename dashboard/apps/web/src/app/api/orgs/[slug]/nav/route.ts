/**
 * What the left rail may show for one organization: its name, and what the
 * reader is allowed to do in it.
 *
 * A route rather than props because the rail is rendered by the app shell, which
 * sits above every organization screen and cannot be handed anything by them.
 *
 * A handle that exists but is not this account's answers exactly as one that does
 * not, so this cannot be used to find out which organizations a Polaris has.
 */

import { requireUser } from "@/lib/session";
import { canDeleteOrg, orgIdForSlug, resolveOrgAccess, getOrg } from "@/lib/orgs/org-service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
    const user = await requireUser();
    const { slug } = await params;

    const orgId = await orgIdForSlug(slug.toLowerCase());
    if (!orgId) return new Response(null, { status: 404 });

    const access = await resolveOrgAccess({ id: user.id, isAdmin: user.isAdmin }, orgId);
    if (!access) return new Response(null, { status: 404 });

    const org = await getOrg(orgId);
    if (!org) return new Response(null, { status: 404 });

    const canDelete = await canDeleteOrg({ id: user.id, isAdmin: user.isAdmin }, orgId);
    return Response.json({ name: org.name, permissions: access.permissions, canDelete });
}
