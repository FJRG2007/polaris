"use server";

/**
 * Actions behind the clickable actor in the activity feed: look up a user's
 * profile, and (for admins) ban or unban them. Email and ban details are only
 * returned to admins; a ban records the time, drops the user's sessions so it is
 * immediate, and is enforced on their next request by requireUser.
 */

import { prisma } from "@polaris/db";
import { requireAdmin, requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";

export interface UserProfile {
    id: string;
    name: string;
    /** Only populated for admin viewers. */
    email: string | null;
    isAdmin: boolean;
    banned: boolean;
    /** Only populated for admin viewers. */
    banReason: string | null;
    /** True when the profile is the viewer's own account. */
    self: boolean;
    /** Whether the viewer may ban/unban. */
    viewerIsAdmin: boolean;
}

export async function getUserProfileAction(userId: string): Promise<{ profile?: UserProfile; error?: string }> {
    const viewer = await requireUser();
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, isAdmin: true, bannedAt: true, banReason: true }
    });
    if (!user) return { error: "User not found." };
    const admin = viewer.isAdmin;
    return {
        profile: {
            id: user.id,
            name: user.name,
            email: admin ? user.email : null,
            isAdmin: user.isAdmin,
            banned: user.bannedAt !== null,
            banReason: admin ? user.banReason : null,
            self: user.id === viewer.id,
            viewerIsAdmin: admin
        }
    };
}

export async function banUserAction(userId: string, reason: string): Promise<{ error?: string }> {
    const viewer = await requireAdmin();
    if (userId === viewer.id) return { error: "You can't ban yourself." };
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) return { error: "User not found." };
    await prisma.user.update({
        where: { id: userId },
        data: { bannedAt: new Date(), banReason: reason.trim() || null }
    });
    // Drop existing sessions so the ban is immediate, not just on next login.
    await prisma.session.deleteMany({ where: { userId } });
    await recordAudit({ actorId: viewer.id, action: "user.ban", targetType: "user", targetId: userId });
    return {};
}

export async function unbanUserAction(userId: string): Promise<{ error?: string }> {
    const viewer = await requireAdmin();
    await prisma.user.update({ where: { id: userId }, data: { bannedAt: null, banReason: null } });
    await recordAudit({ actorId: viewer.id, action: "user.unban", targetType: "user", targetId: userId });
    return {};
}
