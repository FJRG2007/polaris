/**
 * Server-side access to the two-factor plugin's endpoints.
 *
 * The plugin is registered as a plain BetterAuthPlugin (see auth.ts) so this
 * package's emitted declarations stay portable, which costs the inferred types
 * for its endpoints. Rather than spread that gap across call sites, the one
 * endpoint Polaris needs on the server is narrowed here, in the module that owns
 * the auth instance - everywhere else keeps a plain, typed function.
 *
 * Enrollment, disabling, and the sign-in challenge all run through the browser
 * client, which types those paths itself.
 */

import { prisma } from "@polaris/db";
import type { Auth } from "./auth.js";

interface TwoFactorEndpoints {
    verifyTOTP(input: { body: { code: string }; headers: Headers }): Promise<unknown>;
}

/**
 * Verify a TOTP code against the signed-in user's authenticator. Used to prove
 * identity for an action the password would otherwise gate (setting a new
 * password after forgetting the old one). A wrong code throws inside better-auth;
 * that is a failed check, not an error worth surfacing.
 */
export async function verifyTotpForSession(auth: Auth, headers: Headers, code: string): Promise<boolean> {
    const api = auth.api as unknown as TwoFactorEndpoints;
    try {
        await api.verifyTOTP({ body: { code }, headers });
        return true;
    } catch {
        return false;
    }
}

/** Whether the user has a verified authenticator armed. */
export async function twoFactorEnabled(userId: string): Promise<boolean> {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { twoFactorEnabled: true } });
    return row?.twoFactorEnabled === true;
}
