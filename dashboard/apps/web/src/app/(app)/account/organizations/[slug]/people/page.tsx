/**
 * Who is in the organization, what each of them is here as, and what that
 * reaches.
 *
 * The roster and the teams answer each other: a person's row names the teams
 * they are on, and a team's panel names what it reaches, so "why can this person
 * see that space" is always one click from wherever the question came up.
 */

import { prisma } from "@polaris/db";
import { PeopleView } from "./people-view";
import { hasOrgPermission } from "@polaris/core";
import { listOrgRoles } from "@/lib/orgs/role-service";
import { organizationPolicy } from "@/lib/orgs/policy";
import { listOrgMembers } from "@/lib/orgs/org-service";
import { requireOrgPage } from "@/lib/orgs/page-access";
import { listOrgEmailInvites, listOrgInvitations } from "@/lib/orgs/invitation-service";

export const dynamic = "force-dynamic";

export default async function OrganizationPeoplePage({
    params
}: {
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;
    const { org, access, user } = await requireOrgPage(slug);

    const viewer = { id: user.id, isAdmin: user.isAdmin };
    const canManage = hasOrgPermission(access.permissions, "people.manage");
    const [members, invitations, emailed, roles, policy, settings] = await Promise.all([
        listOrgMembers(org.id, viewer),
        listOrgInvitations(org.id, viewer),
        listOrgEmailInvites(org.id, { canManage }),
        listOrgRoles(org.id),
        organizationPolicy(),
        prisma.organization.findUnique({
            where: { id: org.id },
            select: { defaultInviteRole: true }
        })
    ]);

    return (
        <PeopleView
            orgId={org.id}
            orgSlug={org.slug}
            members={members}
            invitations={invitations}
            emailed={emailed}
            roles={roles.map((role) => ({
                slug: role.slug,
                name: role.name,
                description: role.description
            }))}
            defaultInviteRole={settings?.defaultInviteRole ?? "member"}
            currentUserId={user.id}
            canManage={canManage}
            // Whether an address with no account can be invited from here, so
            // the form can say so before somebody types one rather than after.
            canInviteNewPeople={
                policy.newPeople === "managers" || (policy.newPeople === "admins" && user.isAdmin)
            }
            memberLimit={policy.maxMembers}
        />
    );
}
