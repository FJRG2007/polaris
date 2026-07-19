/**
 * Account self-service. Lets a signed-in user change their own profile, email,
 * and password. Credential checks and hashing go through better-auth's context -
 * the same hasher sign-in verifies against - so there is one source of truth for
 * how passwords are stored. Email and password changes re-verify the current
 * password first; profile edits (name, username) do not touch credentials.
 */

import { prisma } from "@polaris/db";
import type { Auth } from "./auth.js";

/** Read the credential password hash for a user, or null if they have none. */
async function credentialHash(userId: string): Promise<string | null> {
    const account = await prisma.account.findFirst({
        where: { userId, providerId: "credential" },
        select: { password: true }
    });
    return account?.password ?? null;
}

/** Verify a user's current password against their stored credential hash. */
async function verifyPassword(auth: Auth, userId: string, password: string): Promise<boolean> {
    const hash = await credentialHash(userId);
    if (!hash) return false;
    const ctx = await auth.$context;
    return ctx.password.verify({ hash, password });
}

/** Update a user's own display name and/or username. Username must stay unique. */
export async function updateUserProfile(
    userId: string,
    input: { name?: string; username?: string | null }
): Promise<{ error?: string }> {
    const data: { name?: string; username?: string | null } = {};
    if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) return { error: "Name cannot be empty." };
        data.name = name;
    }
    if (input.username !== undefined) {
        const username = input.username?.trim().toLowerCase() || null;
        if (username) {
            if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
                return { error: "Username must be 3-32 characters: letters, numbers, . _ -" };
            }
            const taken = await prisma.user.findFirst({
                where: { username, id: { not: userId } },
                select: { id: true }
            });
            if (taken) return { error: "That username is already taken." };
        }
        data.username = username;
    }
    if (Object.keys(data).length > 0) await prisma.user.update({ where: { id: userId }, data });
    return {};
}

/** Change a user's own email after re-verifying their password. Email stays unique. */
export async function changeUserEmail(
    auth: Auth,
    userId: string,
    newEmail: string,
    currentPassword: string
): Promise<{ error?: string }> {
    const email = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email address." };
    if (!(await verifyPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    const taken = await prisma.user.findFirst({ where: { email, id: { not: userId } }, select: { id: true } });
    if (taken) return { error: "That email is already in use." };
    // Email changed: clear the verified flag so any future verification flow re-runs.
    await prisma.user.update({ where: { id: userId }, data: { email, emailVerified: false } });
    return {};
}

/** Change a user's own password after re-verifying the current one. */
export async function changeUserPassword(
    auth: Auth,
    userId: string,
    currentPassword: string,
    newPassword: string,
    minLength = 10
): Promise<{ error?: string }> {
    if (newPassword.length < minLength) {
        return { error: `New password must be at least ${minLength} characters.` };
    }
    if (!(await verifyPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    const ctx = await auth.$context;
    const hash = await ctx.password.hash(newPassword);
    await prisma.account.updateMany({
        where: { userId, providerId: "credential" },
        data: { password: hash }
    });
    return {};
}
