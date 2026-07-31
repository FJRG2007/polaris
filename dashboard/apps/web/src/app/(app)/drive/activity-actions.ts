"use server";

/**
 * Actions behind the clickable actor in the activity feed: look up a user's
 * profile, and (for admins) ban or unban them. Email and ban details are only
 * returned to admins; banning itself belongs to the user-administration service,
 * so a ban means the same thing here as it does in the people directory.
 */

import { prisma } from "@polaris/db";
import { requireAdmin, requireUser } from "@/lib/session";
import { banUser, unbanUser } from "@/lib/user-admin-service";

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
    return banUser(viewer.id, userId, reason);
}

export async function unbanUserAction(userId: string): Promise<{ error?: string }> {
    const viewer = await requireAdmin();
    return unbanUser(viewer.id, userId);
}
