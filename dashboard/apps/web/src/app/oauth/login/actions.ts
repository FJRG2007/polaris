"use server";

/**
 * Resolve a sign-in identifier (email or username) to the account email, so the
 * client can complete sign-in through better-auth's email flow. Returns null when
 * no account matches; the caller shows a generic error either way, so this never
 * confirms whether a given username exists.
 */

import { prisma } from "@polaris/db";

export async function resolveIdentifier(identifier: string): Promise<string | null> {
    const value = identifier.trim().toLowerCase();
    if (value.includes("@")) return value;
    const user = await prisma.user.findUnique({ where: { username: value }, select: { email: true } });
    return user?.email ?? null;
}
