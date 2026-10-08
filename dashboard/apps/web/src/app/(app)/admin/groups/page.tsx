/**
 * Groups admin. Lists every group with the first page of its members and lets an
 * admin create groups and manage membership. Policies are bound to groups on the
 * Policies page; here we only shape who belongs to what.
 *
 * Neither the rosters nor the people who could join them are read whole: a group
 * can be everybody a deployment serves, so each arrives with a page and a count,
 * its dialog reads the rest as it is scrolled, and somebody to add is found by
 * name.
 */

import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { firstMembers, GROUP_PREVIEW } from "@/lib/group-members";
import { GroupsAdmin, type GroupRow } from "./groups-admin";

export const dynamic = "force-dynamic";

export default async function GroupsAdminPage() {
    await requireAdmin();
    const t = await getTranslations("admin");
    const groups = await prisma.group.findMany({
        orderBy: { name: "asc" },
        select: {
            id: true,
            name: true,
            description: true,
            isSystem: true,
            _count: { select: { members: true } },
            members: {
                orderBy: { userId: "asc" },
                take: GROUP_PREVIEW + 1,
                select: { user: { select: { id: true, name: true, email: true } } }
            }
        }
    });

    const rows: GroupRow[] = groups.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        isSystem: group.isSystem,
        memberCount: group._count.members,
        members: firstMembers(group.members)
    }));

    return (
        <>
            <PageHeader title={t("groups.page.title")} description={t("groups.page.description")} />
            <GroupsAdmin groups={rows} />
        </>
    );
}
