/**
 * What the groups screen lists, read on the server.
 *
 * The page starts this read without awaiting it and streams the answer in the
 * same response as its shell, so a visit is one round trip; the action in
 * `data.ts` is what a retry or a refresh after a change asks instead.
 *
 * Bounded on every axis: at most `GROUPS_LIMIT` groups, and at most a preview
 * page of each roster. The previews used to be a nested `take` in the groups
 * query, which Prisma applies in memory: it read every membership of every
 * listed group, and every one of those users, to keep twenty of each. They are
 * one lateral query now, which walks the membership primary key
 * (`groupId`, `userId`) and stops after the page.
 */

import { prisma } from "@polaris/db";
import type { GroupRow } from "./groups-admin";
import { firstMembers, GROUP_PREVIEW, type GroupMemberView } from "@/lib/group-members";

/** The most groups the screen lists - far past what a deployment keeps. */
export const GROUPS_LIMIT = 1000;

export async function readGroupsAdmin(): Promise<GroupRow[]> {
    const groups = await prisma.group.findMany({
        orderBy: { name: "asc" },
        take: GROUPS_LIMIT,
        select: {
            id: true,
            name: true,
            description: true,
            isSystem: true,
            _count: { select: { members: true } }
        }
    });
    const previews = await readPreviews(groups.map((group) => group.id));
    return groups.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        isSystem: group.isSystem,
        memberCount: group._count.members,
        members: firstMembers((previews.get(group.id) ?? []).map((user) => ({ user })))
    }));
}

/** The first `GROUP_PREVIEW + 1` members of each group, by member id. */
async function readPreviews(groupIds: readonly string[]): Promise<Map<string, GroupMemberView[]>> {
    const byGroup = new Map<string, GroupMemberView[]>();
    if (groupIds.length === 0) return byGroup;
    const rows = await prisma.$queryRaw<(GroupMemberView & { groupId: string })[]>`
        SELECT g."id" AS "groupId", u."id", u."name", u."email"
        FROM unnest(${[...groupIds]}::uuid[]) AS g("id")
        CROSS JOIN LATERAL (
            SELECT m."userId" FROM "GroupMember" m
            WHERE m."groupId" = g."id"
            ORDER BY m."userId"
            LIMIT ${GROUP_PREVIEW + 1}
        ) m
        JOIN "User" u ON u."id" = m."userId"
        ORDER BY g."id", u."id"`;
    for (const row of rows) {
        const list = byGroup.get(row.groupId) ?? [];
        list.push({ id: row.id, name: row.name, email: row.email });
        byGroup.set(row.groupId, list);
    }
    return byGroup;
}
