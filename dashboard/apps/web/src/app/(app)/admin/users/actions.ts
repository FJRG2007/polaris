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

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { setSharingPolicy } from "@/lib/sharing-policy";
import { accessRulesSchema, createInviteSchema, sharingPolicySchema } from "@polaris/core";
import { decideRecoveryRequest } from "@/lib/account-recovery-service";
import { listUserSessions, type SessionView } from "@/lib/session-directory";
import { createInvite, revokeInvite, type CreatedInvite } from "@/lib/invite-service";
import {
    banUser,
    deleteUser,
    revokeSessionForUser,
    revokeUserSessions,
    setAdminAccess,
    setUserLimits,
    setUserRole,
    unbanUser
} from "@/lib/user-admin-service";

/** Account and session ids are uuids; anything else matches nothing anyway, and
 *  is refused here rather than sent to the database. */
const idSchema = z.string().uuid();

export async function createInviteAction(input: unknown): Promise<CreatedInvite & { error?: string }> {
    const admin = await requireAdmin();
    const parsed = createInviteSchema.safeParse(input);
    if (!parsed.success) return { id: "", error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const created = await createInvite(admin.id, parsed.data);
    // A refused invite created nothing, so there is nothing to record and nothing
    // to refresh - only a reason to hand back.
    if (created.error) return created;
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

/**
 * Let somebody back into their account, or refuse to. Approving grants nothing on
 * its own - it lets the person holding the ticket choose their own password, so
 * an administrator never learns what they picked.
 */
export async function decideRecoveryRequestAction(id: string, approve: boolean): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const result = await decideRecoveryRequest(admin.id, String(id), approve === true);
    revalidatePath("/admin/users");
    return result;
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
    // Roles are rows, not a fixed list: the service settles whether this one
    // exists rather than a copy of the names kept here.
    const result = await setUserRole(admin.id, userId, String(role));
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

/**
 * Every session an account holds. Read when the dialog opens rather than with
 * the directory: most rows are never expanded, and the list is the one part of a
 * person's record that changes while you are looking at it.
 *
 * Nothing here is the caller's own session, so none is flagged as current.
 */
export async function userSessionsAction(userId: unknown): Promise<{ sessions?: SessionView[]; error?: string }> {
    await requireAdmin();
    const parsed = idSchema.safeParse(userId);
    if (!parsed.success) return { error: "Unknown account." };
    return { sessions: await listUserSessions(parsed.data, "") };
}

/** End one session of somebody else's without ending the rest. */
export async function revokeUserSessionAction(userId: unknown, sessionId: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const target = idSchema.safeParse(userId);
    const session = idSchema.safeParse(sessionId);
    if (!target.success || !session.success) return { error: "Unknown session." };
    const result = await revokeSessionForUser(admin.id, target.data, session.data);
    revalidatePath("/admin/users");
    return result;
}

export async function deleteUserAction(userId: string): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const result = await deleteUser(admin.id, userId);
    revalidatePath("/admin/users");
    return result;
}

/** Who, besides an administrator, may bring somebody in. */
export async function setSharingPolicyAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = sharingPolicySchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the settings and try again" };
    await setSharingPolicy(parsed.data);
    await recordAudit({
        actorId: admin.id,
        action: "settings.sharing",
        targetType: "setting",
        targetId: "sharing.policy",
        metadata: { delegated: parsed.data.delegated, inviteRole: parsed.data.inviteRole }
    });
    revalidatePath("/admin/users");
    return {};
}
