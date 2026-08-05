/**
 * The organization's own settings: what it is called, what it looks like, and -
 * for its owner alone - handing it on or ending it.
 *
 * The split is deliberate. A name, a photo and a handle are things the people
 * running an organization change; giving the organization away and deleting it
 * are not, and no role anybody writes can be given them.
 */

import { SettingsView } from "./settings-view";
import { requireOrgPage } from "@/lib/orgs/page-access";
import { listOrgMembers, orgDeletionImpact } from "@/lib/orgs/org-service";

export const dynamic = "force-dynamic";

export default async function OrganizationSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const { org, access } = await requireOrgPage(slug, "settings.manage");

    // Only the owner sees the two dangerous halves, so their inputs are only
    // fetched for them.
    const [members, impact] = await Promise.all([
        access.isOwner ? listOrgMembers(org.id) : Promise.resolve([]),
        access.isOwner ? orgDeletionImpact(org.id) : Promise.resolve({ spaces: 0, tasks: 0 })
    ]);

    return (
        <SettingsView
            org={org}
            isOwner={access.isOwner}
            candidates={members
                .filter((member) => member.role !== "owner")
                .map((member) => ({ userId: member.userId, name: member.name }))}
            impact={impact}
        />
    );
}
