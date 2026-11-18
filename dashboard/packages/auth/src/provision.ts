/**
 * Server-side account creation. Public sign-up is disabled, so the setup and
 * invite flows create users through better-auth's internal context rather than
 * the closed endpoint: hash the password with the same hasher sign-in verifies
 * against, create the user, and link a credential account. This keeps one source
 * of truth for how credentials are stored while keeping registration closed.
 */

import { prisma } from "@polaris/db";
import type { Auth } from "./auth.js";
import { emailOwner } from "./account.js";

export interface ProvisionInput {
    readonly email: string;
    readonly name: string;
    readonly password: string;
    readonly username?: string;
}

/** True once at least one account exists (setup is complete). */
export async function hasAnyUser(): Promise<boolean> {
    return (await prisma.user.count()) > 0;
}

/** Create a credentialed user. Throws if the email or username is taken. */
export async function provisionUser(auth: Auth, input: ProvisionInput): Promise<{ id: string }> {
    const email = input.email.trim().toLowerCase();
    const username = input.username?.trim().toLowerCase();
    // Every address an account holds, not only the one it signs in with: an
    // alternate is an address its owner has proved - or that a provider they
    // linked vouched for - and a second account under it would be a way to
    // receive that person's mail.
    if (await emailOwner(email)) {
        throw new Error("An account with that email already exists");
    }
    if (username && (await prisma.user.findUnique({ where: { username }, select: { id: true } }))) {
        throw new Error("That username is already taken");
    }

    const ctx = await auth.$context;
    const hash = await ctx.password.hash(input.password);
    const user = await ctx.internalAdapter.createUser(
        {
            email,
            name: input.name.trim(),
            username,
            emailVerified: false
        },
        { method: "email-password" }
    );
    await ctx.internalAdapter.linkAccount({
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: hash
    });
    return { id: user.id };
}

/**
 * Point every password back at the account it belongs to.
 *
 * better-auth reads a password only from the "credential" row whose
 * `accountId` is the user's id, and answers "Invalid email or password" when
 * there is none - so a row carrying any other value locks that account out of
 * password sign-in with the right password, while Polaris's own checks (which
 * find the row by user) keep accepting it. Rows like that were written before
 * user ids became uuids, and a transfer from such an install brings them back
 * after the migration that fixed them has already run.
 *
 * Run at every start, after an import, and whenever a password is written, so
 * the state cannot outlive the next boot whatever path produced it. Only the
 * one row better-auth would use is moved, and never onto a user that already
 * has a matching one. Returns how many changed.
 */
export async function repairCredentialAccounts(userId?: string): Promise<number> {
    if (userId) {
        const rows = await prisma.account.findMany({
            where: { userId, providerId: "credential" },
            select: { id: true, accountId: true, password: true, updatedAt: true }
        });
        if (rows.some((row) => row.accountId === userId)) return 0;
        const [best] = rows.sort(
            (a, b) =>
                Number(a.password === null) - Number(b.password === null) ||
                b.updatedAt.getTime() - a.updatedAt.getTime()
        );
        if (!best) return 0;
        await prisma.account.update({ where: { id: best.id }, data: { accountId: userId } });
        return 1;
    }
    return prisma.$executeRaw`
        UPDATE "Account" SET "accountId" = CAST("userId" AS TEXT)
        WHERE "providerId" = 'credential'
          AND "accountId" <> CAST("userId" AS TEXT)
          AND NOT EXISTS (
              SELECT 1 FROM "Account" AS b
              WHERE b."userId" = "Account"."userId" AND b."providerId" = 'credential'
                AND b."accountId" = CAST(b."userId" AS TEXT)
          )
          AND "id" = (
              SELECT c."id" FROM "Account" AS c
              WHERE c."userId" = "Account"."userId" AND c."providerId" = 'credential'
              ORDER BY c."password" IS NULL, c."updatedAt" DESC
              LIMIT 1
          )`;
}

/** Promote a user to administrator (the second gate for operator surfaces). */
export async function setUserAdmin(userId: string): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { isAdmin: true } });
}
