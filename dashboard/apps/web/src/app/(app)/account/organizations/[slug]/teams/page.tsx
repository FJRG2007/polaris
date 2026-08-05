/**
 * The organization's teams: what they are, who is on them, and what they reach.
 *
 * A team is the unit work is granted to. Being on the roster reaches nothing on
 * its own, which is the rule the empty state has to teach - otherwise somebody
 * adds five people, sees no work appear, and concludes the whole thing is broken.
 */

import { TeamsView } from "./teams-view";
import { hasOrgPermission } from "@polaris/core";
import { listTeams } from "@/lib/orgs/org-service";
import { organizationPolicy } from "@/lib/orgs/policy";
import { requireOrgPage } from "@/lib/orgs/page-access";

export const dynamic = "force-dynamic";

export default async function OrganizationTeamsPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const { org, access, user } = await requireOrgPage(slug);

    const [teams, policy] = await Promise.all([listTeams(org.id), organizationPolicy()]);

    return (
        <TeamsView
            orgId={org.id}
            orgName={org.name}
            teams={teams}
            currentUserId={user.id}
            canManage={hasOrgPermission(access.permissions, "teams.manage")}
            teamLimit={policy.maxTeams}
        />
    );
}
