/**
 * One organization: its roster, its teams, and - for its owner - the settings
 * that rename, hand over or delete it.
 *
 * Reached by handle rather than by id, so a link somebody pastes into a message
 * reads as the organization it opens.
 */

import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { OrganizationView } from "./organization-view";
import { organizationPolicy } from "@/lib/orgs/policy";
import {
    getOrg,
    listOrgMembers,
    listTeams,
    orgDeletionImpact,
    orgIdForSlug,
    resolveOrgRole
} from "@/lib/orgs/org-service";

export const dynamic = "force-dynamic";

export default async function OrganizationPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const user = await requireUser();

    const orgId = await orgIdForSlug(slug.toLowerCase());
    if (!orgId) notFound();

    // A handle that exists but is not this account's is answered exactly as one
    // that does not exist, so the page cannot be used to discover organizations.
    const role = await resolveOrgRole({ id: user.id, isAdmin: user.isAdmin }, orgId);
    if (!role) notFound();

    const [org, members, teams, impact, policy] = await Promise.all([
        getOrg(orgId),
        listOrgMembers(orgId),
        listTeams(orgId),
        orgDeletionImpact(orgId),
        organizationPolicy()
    ]);
    if (!org) notFound();

    return (
        <OrganizationView
            org={org}
            role={role}
            currentUserId={user.id}
            members={members}
            teams={teams}
            impact={impact}
            memberLimit={policy.maxMembers}
            teamLimit={policy.maxTeams}
        />
    );
}
