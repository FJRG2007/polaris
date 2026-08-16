/**
 * Who is in the organization, what each of them is here as, and what that
 * reaches.
 *
 * The roster and the teams answer each other: a person's row names the teams
 * they are on, and a team's panel names what it reaches, so "why can this person
 * see that space" is always one click from wherever the question came up.
 */

import { PeopleView } from "./people-view";
import { hasOrgPermission } from "@polaris/core";
import { listOrgRoles } from "@/lib/orgs/role-service";
import { organizationPolicy } from "@/lib/orgs/policy";
import { listOrgMembers } from "@/lib/orgs/org-service";
import { listOrgInvitations } from "@/lib/orgs/invitation-service";
import { requireOrgPage } from "@/lib/orgs/page-access";

export const dynamic = "force-dynamic";

export default async function OrganizationPeoplePage({
    params
}: {
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;
    const { org, access, user } = await requireOrgPage(slug);

    const viewer = { id: user.id, isAdmin: user.isAdmin };
    const [members, invitations, roles, policy] = await Promise.all([
        listOrgMembers(org.id, viewer),
        listOrgInvitations(org.id, viewer),
        listOrgRoles(org.id),
        organizationPolicy()
    ]);

    return (
        <PeopleView
            orgId={org.id}
            orgSlug={org.slug}
            members={members}
            invitations={invitations}
            roles={roles.map((role) => ({
                slug: role.slug,
                name: role.name,
                description: role.description
            }))}
            currentUserId={user.id}
            canManage={hasOrgPermission(access.permissions, "people.manage")}
            memberLimit={policy.maxMembers}
        />
    );
}
