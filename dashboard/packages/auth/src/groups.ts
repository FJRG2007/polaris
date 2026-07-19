/**
 * Groups: named bundles of users that policies attach to. Managing access at the
 * group level (rather than per user) is what keeps authorization tractable as the
 * number of users and shared resources grows. All operations here are plain
 * database reads/writes; the authorization decision itself lives in ./authz.ts.
 */

import { prisma } from "@polaris/db";

/** A group with its member count, for admin listings. */
export interface GroupSummary {
    id: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    memberCount: number;
}

/** A single member of a group. */
export interface GroupMemberInfo {
    id: string;
    name: string;
    email: string;
}

/** Create a group. Throws if the name is already taken. */
export async function createGroup(name: string, description?: string): Promise<{ id: string }> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Enter a group name");
    return prisma.group.create({
        data: { name: trimmed, description: description?.trim() || null },
        select: { id: true }
    });
}

/** Delete a group (its memberships cascade). System groups are protected. */
export async function deleteGroup(id: string): Promise<void> {
    await prisma.group.deleteMany({ where: { id, isSystem: false } });
}

/** All groups with member counts, alphabetical. */
export async function listGroups(): Promise<GroupSummary[]> {
    const rows = await prisma.group.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, description: true, isSystem: true, _count: { select: { members: true } } }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        isSystem: row.isSystem,
        memberCount: row._count.members
    }));
}

/** A group with its resolved members, or null if it does not exist. */
export async function getGroupWithMembers(
    id: string
): Promise<{ id: string; name: string; description: string | null; members: GroupMemberInfo[] } | null> {
    const group = await prisma.group.findUnique({
        where: { id },
        select: {
            id: true,
            name: true,
            description: true,
            members: { select: { user: { select: { id: true, name: true, email: true } } } }
        }
    });
    if (!group) return null;
    return {
        id: group.id,
        name: group.name,
        description: group.description,
        members: group.members.map((member) => member.user)
    };
}

/** Add a user to a group. No-op if already a member. */
export async function addGroupMember(groupId: string, userId: string): Promise<void> {
    await prisma.groupMember.upsert({
        where: { groupId_userId: { groupId, userId } },
        create: { groupId, userId },
        update: {}
    });
}

/** Remove a user from a group. Idempotent. */
export async function removeGroupMember(groupId: string, userId: string): Promise<void> {
    await prisma.groupMember.deleteMany({ where: { groupId, userId } });
}

/** The ids of every group a user belongs to (used to resolve group-scoped grants). */
export async function getUserGroupIds(userId: string): Promise<string[]> {
    const rows = await prisma.groupMember.findMany({ where: { userId }, select: { groupId: true } });
    return rows.map((row) => row.groupId);
}
