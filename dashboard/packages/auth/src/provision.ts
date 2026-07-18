/**
 * Server-side account creation. Public sign-up is disabled, so the setup and
 * invite flows create users through better-auth's internal context rather than
 * the closed endpoint: hash the password with the same hasher sign-in verifies
 * against, create the user, and link a credential account. This keeps one source
 * of truth for how credentials are stored while keeping registration closed.
 */

import { prisma } from "@polaris/db";
import type { Auth } from "./auth.js";

export interface ProvisionInput {
    readonly email: string;
    readonly name: string;
    readonly password: string;
}

/** True once at least one account exists (setup is complete). */
export async function hasAnyUser(): Promise<boolean> {
    return (await prisma.user.count()) > 0;
}

/** Create a credentialed user. Throws if the email is already taken. */
export async function provisionUser(auth: Auth, input: ProvisionInput): Promise<{ id: string }> {
    const email = input.email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new Error("An account with that email already exists");

    const ctx = await auth.$context;
    const hash = await ctx.password.hash(input.password);
    const user = await ctx.internalAdapter.createUser({
        email,
        name: input.name.trim(),
        emailVerified: false
    });
    await ctx.internalAdapter.linkAccount({
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: hash
    });
    return { id: user.id };
}

/** Promote a user to administrator (the second gate for operator surfaces). */
export async function setUserAdmin(userId: string): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { isAdmin: true } });
}
