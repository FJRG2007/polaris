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

/**
 * Browsers that answered the challenge and asked to be remembered.
 *
 * better-auth records each one as a verification row keyed by a random
 * identifier and valued with the user id, and reads it back from a cookie before
 * the challenge is raised - so while one stands, that browser signs in with the
 * password alone. Nothing about the device is stored beyond when the pass runs
 * out, which is why the account page can only count them and drop them.
 */
const TRUST_PREFIX = "trust-device-";

export async function countTrustedDevices(userId: string): Promise<number> {
    return prisma.verification.count({
        where: { identifier: { startsWith: TRUST_PREFIX }, value: userId, expiresAt: { gt: new Date() } }
    });
}

/**
 * Stop remembering every browser at once, so the next sign-in on each asks for a
 * code again. All of them rather than a chosen one: the rows carry nothing that
 * would let somebody tell which is which, and the reason to reach for this is
 * that a device is out of the owner's hands.
 *
 * Expired rows go with them - they no longer let anyone in, and leaving them
 * would make the count on the page disagree with what it dropped.
 */
export async function revokeTrustedDevices(userId: string): Promise<number> {
    const { count } = await prisma.verification.deleteMany({
        where: { identifier: { startsWith: TRUST_PREFIX }, value: userId }
    });
    return count;
}
