"use server";

/** Admin-only group management: create/delete groups and manage membership. */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { addGroupMember, createGroup, deleteGroup, removeGroupMember } from "@polaris/auth";
import { requireAdmin } from "@/lib/session";
import { publishAccessChange } from "@/lib/access-live";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { MAX_PAGE, type Page } from "@/lib/pagination/cursor";
import {
    findGroupCandidates,
    groupsWithMember,
    readGroupMembers,
    type GroupMemberView
} from "@/lib/group-members";

export async function createGroupAction(name: string, description?: string): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    try {
        const { id } = await createGroup(name, description);
        await recordAudit({ actorId: admin.id, action: "group.create", targetType: "group", targetId: id, metadata: { name } });
    } catch (caught) {
        const t = await getTranslations("admin");
        return { error: caught instanceof Error ? caught.message : t("groups.errors.createFailed") };
    }
    revalidatePath("/admin/groups");
    return {};
}

export async function deleteGroupAction(id: string): Promise<void> {
    const admin = await requireAdmin();
    await deleteGroup(id);
    // Whoever was in it, which the cascade has just taken away - see
    // `access-live` for why nobody is named.
    publishAccessChange();
    await recordAudit({ actorId: admin.id, action: "group.delete", targetType: "group", targetId: id });
    revalidatePath("/admin/groups");
}

export async function addGroupMemberAction(groupId: string, userId: string): Promise<void> {
    const admin = await requireAdmin();
    await addGroupMember(groupId, userId);
    publishAccessChange({ userIds: [userId] });
    await recordAudit({ actorId: admin.id, action: "group.member.add", targetType: "group", targetId: groupId, metadata: { userId } });
    revalidatePath("/admin/groups");
}

export async function removeGroupMemberAction(groupId: string, userId: string): Promise<void> {
    const admin = await requireAdmin();
    await removeGroupMember(groupId, userId);
    publishAccessChange({ userIds: [userId] });
    await recordAudit({ actorId: admin.id, action: "group.member.remove", targetType: "group", targetId: groupId, metadata: { userId } });
    revalidatePath("/admin/groups");
}

const groupIdSchema = z.string().uuid();
const searchSchema = z.string().trim().max(120);

/** The next page of a group's members, after the member `cursor` names. */
export async function listGroupMembersAction(
    groupId: string,
    cursor: string | null,
    limit?: number
): Promise<Page<GroupMemberView> | { error: string }> {
    await requireAdmin();
    const id = groupIdSchema.safeParse(groupId);
    const size = z.number().int().min(1).max(MAX_PAGE).optional().safeParse(limit);
    const t = await getTranslations("admin");
    if (!id.success || !size.success) return { error: t("users.directory.loadFailed") };
    try {
        return await readGroupMembers(id.data, cursor, size.data);
    } catch {
        return { error: t("users.directory.loadFailed") };
    }
}

/** The groups a person whose name or email was typed is in. */
export async function findGroupsByMemberAction(query: string): Promise<{ ids: string[] }> {
    await requireAdmin();
    const term = searchSchema.safeParse(query);
    if (!term.success) return { ids: [] };
    return { ids: await groupsWithMember(term.data) };
}

/** People to add to a group, found by name, email or username. Somebody already
 *  in it is still shown - their name was typed - but cannot be picked. */
export async function findGroupCandidatesAction(
    groupId: string,
    query: string
): Promise<{ results: { id: string; name: string; unavailable?: string }[] }> {
    await requireAdmin();
    const id = groupIdSchema.safeParse(groupId);
    const term = searchSchema.safeParse(query);
    if (!id.success || !term.success) return { results: [] };
    const t = await getTranslations("admin");
    const found = await findGroupCandidates(id.data, term.data);
    return {
        results: found.map((person) => ({
            id: person.id,
            name: person.name,
            unavailable: person.member ? t("groups.dialog.alreadyIn") : undefined
        }))
    };
}
