/**
 * What the organization's roles are, and what holding one lets you do.
 *
 * Only somebody the organization trusted with `roles.manage` gets here, because
 * this screen is the one that decides what everybody else can reach - and a role
 * editor that anybody can open is not an access model.
 */

import { RolesView } from "./roles-view";
import { listOrgRoles } from "@/lib/orgs/role-service";
import { requireOrgPage } from "@/lib/orgs/page-access";

export const dynamic = "force-dynamic";

export default async function OrganizationRolesPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const { org } = await requireOrgPage(slug, "roles.manage");

    return <RolesView orgId={org.id} orgSlug={org.slug} roles={await listOrgRoles(org.id)} />;
}
