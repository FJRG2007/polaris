/**
 * Named sets of servers. A group carries no settings of its own; it exists so a rule
 * can be written once for "the VPS boxes" instead of once per machine, and so that
 * adding a server to the group is all it takes for the rule to cover it.
 *
 * Every read and write is owner-scoped, and membership is only ever accepted for
 * servers the same owner holds - otherwise a group would be a way to attach rules to
 * someone else's machine.
 */

import { prisma } from "@polaris/db";

export interface HostGroupView {
    readonly id: string;
    readonly name: string;
    readonly hostIds: string[];
}

/** The owner's groups with their membership, oldest first. */
export async function listHostGroups(ownerId: string): Promise<HostGroupView[]> {
    const rows = await prisma.hostGroup.findMany({
        where: { ownerId },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, members: { select: { hostId: true } } }
    });
    return rows.map((row) => ({ id: row.id, name: row.name, hostIds: row.members.map((member) => member.hostId) }));
}

/** Create a group. The name is unique per owner, so a second one by the same name is
 *  the same group rather than a confusing duplicate. */
export async function createHostGroup(ownerId: string, name: string): Promise<{ id: string }> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("A group name is required");
    const existing = await prisma.hostGroup.findUnique({
        where: { ownerId_name: { ownerId, name: trimmed } },
        select: { id: true }
    });
    if (existing) return existing;
    return prisma.hostGroup.create({ data: { ownerId, name: trimmed }, select: { id: true } });
}

export async function renameHostGroup(ownerId: string, groupId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("A group name is required");
    const { count } = await prisma.hostGroup.updateMany({
        where: { id: groupId, ownerId },
        data: { name: trimmed }
    });
    if (count === 0) throw new Error("Server group not found");
}

/**
 * Delete a group. Its firewall rule goes with it: a rule attached to a scope that no
 * longer exists would keep being resolved into nothing and quietly linger in the
 * table forever.
 */
export async function deleteHostGroup(ownerId: string, groupId: string): Promise<void> {
    const { count } = await prisma.hostGroup.deleteMany({ where: { id: groupId, ownerId } });
    if (count === 0) throw new Error("Server group not found");
    await prisma.wafRule.deleteMany({ where: { scopeType: "server-group", scopeId: groupId } });
}

/**
 * Replace a group's membership. Servers the caller does not own are dropped rather
 * than rejected: the set is what the operator sees on their own screen, and an id
 * that is not theirs cannot have come from it.
 */
export async function setHostGroupMembers(
    ownerId: string,
    groupId: string,
    hostIds: readonly string[]
): Promise<void> {
    if ((await prisma.hostGroup.count({ where: { id: groupId, ownerId } })) === 0) {
        throw new Error("Server group not found");
    }
    const owned = await prisma.host.findMany({
        where: { id: { in: [...new Set(hostIds)] }, ownerId },
        select: { id: true }
    });
    await prisma.$transaction([
        prisma.hostGroupMember.deleteMany({ where: { groupId } }),
        prisma.hostGroupMember.createMany({
            data: owned.map((host) => ({ groupId, hostId: host.id }))
        })
    ]);
}
