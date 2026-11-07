"use server";

import { prisma } from "@polaris/db";
import { requireAdmin } from "@/lib/session";
import type { GroupRow } from "./groups-admin";
import { firstMembers, GROUP_PREVIEW } from "@/lib/group-members";

/** Every group with the first page of its members, asked for after the paint. */
export async function loadGroupsAdminAction(): Promise<GroupRow[]> {
    await requireAdmin();
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
    return groups.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        isSystem: group.isSystem,
        memberCount: group._count.members,
        members: firstMembers(group.members)
    }));
}
