"use server";

/** Admin-only group management: create/delete groups and manage membership. */

import { revalidatePath } from "next/cache";
import { addGroupMember, createGroup, deleteGroup, removeGroupMember } from "@polaris/auth";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";

export async function createGroupAction(name: string, description?: string): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    try {
        const { id } = await createGroup(name, description);
        await recordAudit({ actorId: admin.id, action: "group.create", targetType: "group", targetId: id, metadata: { name } });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the group" };
    }
    revalidatePath("/admin/groups");
    return {};
}

export async function deleteGroupAction(id: string): Promise<void> {
    const admin = await requireAdmin();
    await deleteGroup(id);
    await recordAudit({ actorId: admin.id, action: "group.delete", targetType: "group", targetId: id });
    revalidatePath("/admin/groups");
}

export async function addGroupMemberAction(groupId: string, userId: string): Promise<void> {
    const admin = await requireAdmin();
    await addGroupMember(groupId, userId);
    await recordAudit({ actorId: admin.id, action: "group.member.add", targetType: "group", targetId: groupId, metadata: { userId } });
    revalidatePath("/admin/groups");
}

export async function removeGroupMemberAction(groupId: string, userId: string): Promise<void> {
    const admin = await requireAdmin();
    await removeGroupMember(groupId, userId);
    await recordAudit({ actorId: admin.id, action: "group.member.remove", targetType: "group", targetId: groupId, metadata: { userId } });
    revalidatePath("/admin/groups");
}
