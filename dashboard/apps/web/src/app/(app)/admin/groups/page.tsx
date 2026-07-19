/**
 * Groups admin. Lists every group with its members and lets an admin create
 * groups and manage membership. Policies are bound to groups on the Policies
 * page; here we only shape who belongs to what.
 */

import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { GroupsAdmin, type GroupRow, type UserOption } from "./groups-admin";

export const dynamic = "force-dynamic";

export default async function GroupsAdminPage() {
    await requireAdmin();
    const [groups, users] = await Promise.all([
        prisma.group.findMany({
            orderBy: { name: "asc" },
            select: {
                id: true,
                name: true,
                description: true,
                isSystem: true,
                members: { select: { user: { select: { id: true, name: true, email: true } } } }
            }
        }),
        prisma.user.findMany({ select: { id: true, name: true, email: true }, orderBy: { name: "asc" } })
    ]);

    const rows: GroupRow[] = groups.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        isSystem: group.isSystem,
        members: group.members.map((member) => member.user)
    }));
    const userOptions: UserOption[] = users.map((user) => ({ id: user.id, name: user.name, email: user.email }));

    return (
        <>
            <PageHeader title="Groups" description="Bundle people into groups, then grant access to the group." />
            <GroupsAdmin groups={rows} users={userOptions} />
        </>
    );
}
