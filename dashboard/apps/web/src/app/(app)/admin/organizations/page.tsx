/**
 * Organizations admin (/admin/organizations): whether this deployment offers
 * them at all, who may start one, and how large they may get - beside the ones
 * that already exist, so the numbers are set against something real rather than
 * guessed.
 */

import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { organizationPolicy } from "@/lib/orgs/policy";
import { OrganizationPolicyForm } from "./policy-form";
import { saveOrganizationPolicyAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function OrganizationsAdminPage() {
    await requireAdmin();

    const [policy, orgs] = await Promise.all([
        organizationPolicy(),
        prisma.organization.findMany({
            orderBy: { name: "asc" },
            select: {
                id: true,
                slug: true,
                name: true,
                owner: { select: { name: true } },
                _count: { select: { members: true, teams: true, spaces: true } }
            }
        })
    ]);

    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title="Organizations"
                description="Work owned by a group rather than by one person. Turn them off entirely, restrict who can start one, or cap how large they get."
            />
            <OrganizationPolicyForm
                initial={policy}
                save={saveOrganizationPolicyAction}
                orgs={orgs.map((org) => ({
                    id: org.id,
                    slug: org.slug,
                    name: org.name,
                    ownerName: org.owner.name,
                    // The owner is not a member row, so the roster is one longer
                    // than the table says.
                    memberCount: org._count.members + 1,
                    teamCount: org._count.teams,
                    spaceCount: org._count.spaces
                }))}
            />
        </div>
    );
}
