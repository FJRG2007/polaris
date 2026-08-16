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
import { saveOrganizationPolicyAction } from "./actions";
import { OrganizationsAdmin } from "./organizations-admin";

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
        // Full width, like the people directory: the list of organizations is a
        // table and reads as one.
        <>
            <PageHeader
                title="Organizations"
                description="Work owned by a group rather than by one person. Turn them off entirely, restrict who can start one, or cap how large they get."
            />
            <OrganizationsAdmin
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
        </>
    );
}
