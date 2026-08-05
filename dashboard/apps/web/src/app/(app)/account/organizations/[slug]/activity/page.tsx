/**
 * What has been done to this organization, and by whom.
 *
 * Its own history, not its people's. An entry is here because the action changed
 * the organization - its roster, its teams, its roles, its domains, its work -
 * and never because the person who took it happens to belong to it. Somebody's
 * own account activity stays on their own Activity screen, where only they can
 * read it.
 */

import { ActivityView } from "./activity-view";
import { requireOrgPage } from "@/lib/orgs/page-access";

export const dynamic = "force-dynamic";

export default async function OrganizationActivityPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const { org } = await requireOrgPage(slug, "activity.read");

    // The heading paints now and the rows arrive after, so opening this never
    // waits on the audit query.
    return (
        <div className="flex flex-col gap-4">
            <div>
                <h2 className="text-base font-semibold">Activity</h2>
                <p className="text-muted-foreground text-sm">
                    Everything done to {org.name}: its people, its teams, its roles, its domains and its work. What
                    somebody does on their own account is not here.
                </p>
            </div>
            <ActivityView slug={org.slug} />
        </div>
    );
}
