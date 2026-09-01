/**
 * The organization's own settings: what it is called, what it looks like, and -
 * for its owner alone - handing it on, or ending it.
 *
 * The split is deliberate. A name, a photo and a handle are things the people
 * running an organization change; giving the organization away and deleting it
 * are not, and no role anybody writes can be given them.
 *
 * Which is why the screen is not behind one permission. Two different people
 * arrive here for two different reasons - somebody who runs the organization, and
 * the successor its owner named, who may do nothing here except end it - and each
 * is shown only their half. Somebody who is neither is answered as though the
 * screen did not exist, exactly as every other organization screen answers.
 */

import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { SettingsView } from "./settings-view";
import { hasOrgPermission } from "@polaris/core";
import { requireOrgFrame } from "@/lib/orgs/page-access";
import { canDeleteOrg, listOrgMembers, orgDeletionImpact } from "@/lib/orgs/org-service";
import { effectiveOrgSuccessor } from "@/lib/successor-service";

export const dynamic = "force-dynamic";

export default async function OrganizationSettingsPage({
    params
}: {
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;
    const user = await requireUser();
    const { org, access } = await requireOrgFrame(slug);

    // Deleting is wider than running the organization - the successor the owner
    // named can do it and nothing else - so it is asked rather than read off the
    // membership.
    const canManage = hasOrgPermission(access.permissions, "settings.manage");
    const canDelete = await canDeleteOrg({ id: user.id, isAdmin: user.isAdmin }, org.id);
    if (!canManage && !canDelete) notFound();

    // Each half's inputs are only fetched for somebody who will be shown it.
    const [members, impact, successor] = await Promise.all([
        access.isOwner
            ? listOrgMembers(org.id, { id: user.id, isAdmin: user.isAdmin })
            : Promise.resolve([]),
        canDelete
            ? orgDeletionImpact(org.id)
            : Promise.resolve({ spaces: 0, tasks: 0, projects: 0 }),
        // The owner alone. Who answers for an organization when its owner is gone
        // is the owner's decision and nobody else's business - a member holding
        // `settings.manage` is not shown the name, let alone offered the field.
        access.isOwner ? effectiveOrgSuccessor(org.id) : Promise.resolve(null)
    ]);

    return (
        <SettingsView
            org={org}
            isOwner={access.isOwner}
            canManage={canManage}
            canDelete={canDelete}
            candidates={members
                .filter((member) => member.role !== "owner")
                .map((member) => ({ userId: member.userId, name: member.name }))}
            successor={successor}
            impact={impact}
        />
    );
}
