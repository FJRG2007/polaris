/**
 * Organizations (/account/organizations): the groups this account belongs to.
 *
 * An account setting rather than an app of its own, because an organization is
 * not somewhere you work - it is who the work belongs to. What you actually do
 * with one happens in Tasks, through the teams it hands spaces to.
 */

import { requireUser } from "@/lib/session";
import { OrganizationsView } from "./organizations-view";
import { listMyOrgs, ownedOrgCount } from "@/lib/orgs/org-service";
import { canCreateOrganization, organizationPolicy } from "@/lib/orgs/policy";

export const dynamic = "force-dynamic";

export default async function OrganizationsPage() {
    const user = await requireUser();
    const [orgs, owned, policy] = await Promise.all([
        listMyOrgs(user.id),
        ownedOrgCount(user.id),
        organizationPolicy()
    ]);
    const creation = await canCreateOrganization(user.isAdmin, owned);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Organizations</h1>
                <p className="text-muted-foreground text-sm">
                    Work that belongs to a group rather than to you. Members reach it through the teams the
                    organization gives its spaces to.
                </p>
            </div>
            <OrganizationsView
                orgs={orgs}
                canCreate={creation.ok}
                blockedReason={creation.ok ? null : creation.reason}
                memberLimit={policy.maxMembers}
            />
        </div>
    );
}
