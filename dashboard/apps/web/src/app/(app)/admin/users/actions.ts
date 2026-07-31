"use server";

/**
 * Admin-only user management: invites, and the changes an administrator can make
 * to somebody else's account. Every action re-checks that the caller is an
 * administrator - a server action is a public endpoint, whatever rendered it.
 *
 * The decisions themselves (who may be banned, what a limit does to open
 * sessions, when the last administrator is protected) live in the service, so
 * this file only validates input and refreshes the page.
 */

import { revalidatePath } from "next/cache";
import { accessRulesSchema, createInviteSchema, INVITE_ROLES } from "@polaris/core";
import { requireAdmin } from "@/lib/session";
import { createInvite, revokeInvite, type CreatedInvite } from "@/lib/invite-service";
import { recordAudit } from "@/lib/audit-service";
import {
    banUser,
    deleteUser,
    revokeUserSessions,
    setAdminAccess,
    setUserLimits,
    setUserRole,
    unbanUser
} from "@/lib/user-admin-service";

export async function createInviteAction(input: unknown): Promise<CreatedInvite & { error?: string }> {
    const admin = await requireAdmin();
    const parsed = createInviteSchema.safeParse(input);
    if (!parsed.success) return { id: "", error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const created = await createInvite(admin.id, parsed.data);
    await recordAudit({
        actorId: admin.id,
        action: "invite.create",
        targetType: "invite",
        targetId: created.id,
        metadata: {
            email: parsed.data.email,
            role: parsed.data.role,
            method: parsed.data.method,
            restricted:
                parsed.data.groupIds.length > 0 ||
                parsed.data.allowedCidrs.length > 0 ||
                parsed.data.allowedCountries.length > 0 ||
                parsed.data.allowedContinents.length > 0
        }
    });
    revalidatePath("/admin/users");
    return created;
}

export async function revokeInviteAction(id: string): Promise<void> {
    const admin = await requireAdmin();
    await revokeInvite(id);
    await recordAudit({ actorId: admin.id, action: "invite.revoke", targetType: "invite", targetId: id });
    revalidatePath("/admin/users");
}

export async function banUserAction(userId: string, reason: string): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const result = await banUser(admin.id, userId, reason);
    revalidatePath("/admin/users");
    return result;
}

export async function unbanUserAction(userId: string): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const result = await unbanUser(admin.id, userId);
    revalidatePath("/admin/users");
    return result;
}

export async function setAdminAccessAction(userId: string, isAdmin: boolean): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const result = await setAdminAccess(admin.id, userId, isAdmin);
    revalidatePath("/admin/users");
    return result;
}

export async function setUserRoleAction(userId: string, role: string): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    if (!(INVITE_ROLES as readonly string[]).includes(role)) return { error: "Unknown role." };
    const result = await setUserRole(admin.id, userId, role);
    revalidatePath("/admin/users");
    return result;
}

export async function setUserLimitsAction(userId: string, input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = accessRulesSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid rules" };
    const result = await setUserLimits(admin.id, userId, parsed.data);
    revalidatePath("/admin/users");
    return result;
}

export async function revokeUserSessionsAction(userId: string): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const result = await revokeUserSessions(admin.id, userId);
    revalidatePath("/admin/users");
    return result;
}

export async function deleteUserAction(userId: string): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const result = await deleteUser(admin.id, userId);
    revalidatePath("/admin/users");
    return result;
}
