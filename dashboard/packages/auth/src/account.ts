/**
 * Account self-service. Lets a signed-in user change their own profile, the
 * addresses on the account, and their password. Credential checks and hashing go
 * through better-auth's context - the same hasher sign-in verifies against - so
 * there is one source of truth for how passwords are stored. Changing what signs
 * in (the primary address) and the password both re-verify the current password
 * first; profile edits (name, username, company) do not touch credentials.
 */

import { companyField } from "@polaris/core";
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

/** Update a user's own display name, username, and/or company. Username must
 *  stay unique; company is free text and may be cleared. */
export async function updateUserProfile(
    userId: string,
    input: { name?: string; username?: string | null; company?: string | null }
): Promise<{ error?: string }> {
    const data: { name?: string; username?: string | null; company?: string | null } = {};
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
    if (input.company !== undefined) {
        const parsed = companyField.safeParse(input.company ?? "");
        if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the company." };
        data.company = parsed.data || null;
    }
    if (Object.keys(data).length > 0) await prisma.user.update({ where: { id: userId }, data });
    return {};
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * A user's addresses. The primary is the one they sign in with and cannot be
 * removed; the rest are alternates, each of which may be flagged as a recovery
 * contact. An address is only ever claimed by one account, so every addition is
 * checked against both the primary addresses and the alternates.
 */
export interface UserEmailView {
    /** Null for the primary, which lives on the user row rather than its own. */
    id: string | null;
    email: string;
    primary: boolean;
    recovery: boolean;
    /** Whether the owner has proved they can read mail at this address. */
    verified: boolean;
    addedAt: string | null;
}

function normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
}

function isEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Whether an address already belongs to somebody - as a primary or an alternate. */
async function emailTaken(email: string, exceptUserId: string): Promise<boolean> {
    const [asPrimary, asAlternate] = await Promise.all([
        prisma.user.findFirst({ where: { email, id: { not: exceptUserId } }, select: { id: true } }),
        prisma.userEmail.findFirst({ where: { email }, select: { id: true } })
    ]);
    return Boolean(asPrimary || asAlternate);
}

/** Every address a user holds, primary first. */
export async function listUserEmails(userId: string): Promise<UserEmailView[]> {
    const [user, alternates] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } }),
        prisma.userEmail.findMany({
            where: { userId },
            orderBy: { createdAt: "asc" },
            select: { id: true, email: true, recovery: true, verifiedAt: true, createdAt: true }
        })
    ]);
    // The primary's verified flag lives on the user row, which better-auth owns;
    // the alternates keep their own stamp.
    const primary: UserEmailView[] = user
        ? [
              {
                  id: null,
                  email: user.email,
                  primary: true,
                  recovery: false,
                  verified: user.emailVerified,
                  addedAt: null
              }
          ]
        : [];
    return [
        ...primary,
        ...alternates.map((row) => ({
            id: row.id,
            email: row.email,
            primary: false,
            recovery: row.recovery,
            verified: row.verifiedAt !== null,
            addedAt: row.createdAt.toISOString()
        }))
    ];
}

/** How many alternates one account may hold, so the list cannot be used as storage. */
export const MAX_ALTERNATE_EMAILS = 10;

/** Add an alternate address. Refused if anybody already holds it. */
export async function addUserEmail(userId: string, newEmail: string): Promise<{ error?: string }> {
    const email = normalizeEmail(newEmail);
    if (!isEmail(email)) return { error: "Enter a valid email address." };
    const current = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (current?.email === email) return { error: "That is already your primary address." };
    if (await emailTaken(email, userId)) return { error: "That email is already in use." };
    const held = await prisma.userEmail.count({ where: { userId } });
    if (held >= MAX_ALTERNATE_EMAILS) {
        return { error: `You can hold at most ${MAX_ALTERNATE_EMAILS} extra addresses.` };
    }
    await prisma.userEmail.create({ data: { userId, email } });
    return {};
}

/** Drop one of a user's own alternate addresses. */
export async function removeUserEmail(userId: string, emailId: string): Promise<{ error?: string }> {
    const result = await prisma.userEmail.deleteMany({ where: { id: emailId, userId } });
    return result.count > 0 ? {} : { error: "That address is no longer on your account." };
}

/** Flag or unflag one of a user's own alternates as a recovery contact. */
export async function setUserEmailRecovery(
    userId: string,
    emailId: string,
    recovery: boolean
): Promise<{ error?: string }> {
    const result = await prisma.userEmail.updateMany({ where: { id: emailId, userId }, data: { recovery } });
    return result.count > 0 ? {} : { error: "That address is no longer on your account." };
}

/**
 * Promote an alternate to primary, which is what a user signs in with - so it
 * re-verifies the password like any other email change. The outgoing primary is
 * kept as an alternate rather than dropped: losing it silently would strip an
 * address the account still owns.
 */
export async function promoteUserEmail(
    auth: Auth,
    userId: string,
    emailId: string,
    currentPassword: string
): Promise<{ error?: string }> {
    const [user, alternate] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } }),
        prisma.userEmail.findFirst({
            where: { id: emailId, userId },
            select: { id: true, email: true, verifiedAt: true }
        })
    ]);
    if (!user || !alternate) return { error: "That address is no longer on your account." };
    if (!(await verifyPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    // Both addresses keep whatever they had proved: verification says the owner
    // can read mail there, which does not stop being true because the address
    // swapped places with the one that signs in.
    await prisma.$transaction([
        prisma.userEmail.delete({ where: { id: alternate.id } }),
        prisma.user.update({
            where: { id: userId },
            data: { email: alternate.email, emailVerified: alternate.verifiedAt !== null }
        }),
        prisma.userEmail.create({
            data: {
                userId,
                email: user.email,
                verifiedAt: user.emailVerified ? new Date() : null
            }
        })
    ]);
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
