/**
 * Arming an account's second factor with an email code instead of an
 * authenticator.
 *
 * better-auth has exactly one second factor and arms it with a TOTP secret, which
 * is the right shape for somebody holding a phone with an authenticator on it and
 * the wrong shape for somebody who has been told at sign-in that they now need one
 * and does not have it. This is the other way in: Polaris sends a code to the
 * address the account signs in with, and answering it arms the same factor with
 * the email method turned on and preferred.
 *
 * Two things follow from doing it that way and both are recorded rather than
 * implied. The TOTP secret better-auth mints is never shown to anybody, so the
 * account is marked as carrying an unclaimed one and nothing offers it an
 * authenticator afterwards. And answering a code sent to the sign-in address is a
 * proof of that address, so it is confirmed here - it is the same evidence the
 * verification link exists to collect, arriving by a different route.
 *
 * The password is asked for because better-auth asks for it: arming the factor
 * goes through its own endpoint, which validates the password for any account that
 * has one. That is the right call and this does not work around it - a control
 * that decides how an account is entered is exactly the kind that should cost the
 * password.
 */

import { auth } from "@/lib/auth";
import { prisma } from "@polaris/db";
import { randomInt } from "node:crypto";
import { sendAuthEmail } from "@/lib/auth-mail";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { hashSecret, setTotpUnclaimed, verifySecret } from "@polaris/auth";
import { TWO_FACTOR_CODE_ATTEMPTS, TWO_FACTOR_CODE_TTL_MINUTES } from "@polaris/core";

/** Where one account's pending enrollment code lives. */
function codeKey(userId: string): string {
    return `enroll-2fa:${userId}`;
}

/** How many codes one account may ask for, and over what span. */
const SEND_LIMIT = 5;
const SEND_WINDOW_MS = 15 * 60 * 1000;

/** Six digits, from the system generator rather than from Math.random - this one
 *  is the only thing standing between a stolen password and an armed factor. */
function newCode(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Send a code to the address the account signs in with.
 *
 * Deliberately not the alternate addresses: the sign-in address is the one the
 * account is known by, and confirming a second address is a thing the owner does
 * from their own settings once they are in.
 */
export async function sendEnrollmentCode(userId: string): Promise<{ error?: string; sentTo?: string }> {
    const throttle = await rateLimit(`2fa-enroll-send:${userId}`, SEND_LIMIT, SEND_WINDOW_MS);
    if (!throttle.ok) return { error: "Too many codes asked for. Wait a few minutes and try again." };

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user?.email) return { error: "This account has no address to send a code to." };

    const code = newCode();
    const expiresAt = new Date(Date.now() + TWO_FACTOR_CODE_TTL_MINUTES * 60_000);
    // One code at a time: a second request replaces the first rather than leaving
    // two open, so a code read off an old mail is a code that no longer works.
    await prisma.verification.deleteMany({ where: { identifier: codeKey(userId) } });
    await prisma.verification.create({
        data: { identifier: codeKey(userId), value: await hashSecret(auth, code), expiresAt }
    });

    const text = [
        `Your Polaris confirmation code is ${code}.`,
        "",
        `It expires in ${TWO_FACTOR_CODE_TTL_MINUTES} minutes and works once.`,
        "It turns on two-step verification for your account. If you did not ask for it, change your password."
    ].join("\n");
    const html = [
        `<p>Your Polaris confirmation code is <strong>${code}</strong>.</p>`,
        `<p>It expires in ${TWO_FACTOR_CODE_TTL_MINUTES} minutes and works once.</p>`,
        "<p>It turns on two-step verification for your account. If you did not ask for it, change your password.</p>"
    ].join("");

    const result = await sendAuthEmail({ to: user.email, subject: "Your Polaris confirmation code", text, html });
    if (result.error) return { error: result.error };
    return { sentTo: user.email };
}

/**
 * Spend a code. Wrong guesses are bounded by the same counter that bounds them
 * everywhere else rather than by a column of its own, and a spent or expired code
 * is deleted so a replay finds nothing.
 */
async function spendEnrollmentCode(userId: string, code: string): Promise<{ error?: string }> {
    const tries = await rateLimit(`2fa-enroll-try:${userId}`, TWO_FACTOR_CODE_ATTEMPTS, TWO_FACTOR_CODE_TTL_MINUTES * 60_000);
    if (!tries.ok) return { error: "Too many wrong tries. Ask for a new code." };

    const row = await prisma.verification.findFirst({
        where: { identifier: codeKey(userId) },
        orderBy: { createdAt: "desc" }
    });
    if (!row) return { error: "Ask for a code first." };
    if (row.expiresAt.getTime() < Date.now()) {
        await prisma.verification.deleteMany({ where: { identifier: codeKey(userId) } });
        return { error: "That code has expired. Ask for a new one." };
    }
    if (!(await verifySecret(auth, row.value, code.trim()))) return { error: "That code is not right." };

    await prisma.verification.deleteMany({ where: { identifier: codeKey(userId) } });
    return {};
}

/** better-auth's enable endpoint, narrowed here rather than across call sites for
 *  the same reason the rest of the plugin is (see two-factor.ts). */
interface EnableEndpoint {
    enableTwoFactor(input: {
        body: { password: string };
        headers: Headers;
    }): Promise<{ backupCodes?: string[] }>;
}

/**
 * Arm the factor against the account's address.
 *
 * The order is the whole safety of it: the code is spent first, so the password
 * alone never arms anything, and better-auth's own endpoint mints the factor so
 * the secret and the backup codes are encrypted exactly the way every other
 * account's are.
 *
 * What is written directly afterwards is what better-auth would have written had
 * the person verified a TOTP code: the factor is marked on and the row verified.
 * That is the one place this steps around the library, and it is deliberate -
 * verifying a TOTP code is not a thing somebody enrolling by email can be asked to
 * do, and the alternative is `skipVerificationOnEnable`, which would also skip it
 * for the people who really are scanning a QR.
 *
 * Returns the backup codes, which are the only way back in for an account whose
 * mail stops working, so the caller must show them once and not store them.
 */
export async function armFactorByEmail(
    userId: string,
    headers: Headers,
    password: string,
    code: string
): Promise<{ error?: string; backupCodes?: string[] }> {
    const spent = await spendEnrollmentCode(userId, code);
    if (spent.error) return { error: spent.error };

    let backupCodes: string[] | undefined;
    try {
        const api = auth.api as unknown as EnableEndpoint;
        ({ backupCodes } = await api.enableTwoFactor({ body: { password }, headers }));
    } catch {
        // better-auth answers the same way for a wrong password and for an account
        // it will not arm, and the code has already been spent either way - so the
        // person asks for a fresh one, which is the honest state to be in.
        return { error: "That password is not right. Ask for a new code and try again." };
    }

    await prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true, emailVerified: true } }),
        prisma.twoFactor.updateMany({ where: { userId }, data: { verified: true } }),
        prisma.userSecurity.upsert({
            where: { userId },
            create: { userId, twoFactorMethods: JSON.stringify(["email"]), twoFactorPreferred: "email" },
            update: { twoFactorMethods: JSON.stringify(["email"]), twoFactorPreferred: "email" }
        })
    ]);
    // Outside the transaction on purpose: it is an upsert on the row just written,
    // and keeping it separate is what lets the note be written by one function that
    // both enrollment paths share.
    await setTotpUnclaimed(userId, true);

    await recordAudit({ actorId: userId, action: "account.2fa.armed", metadata: { factor: "email" } });
    return { backupCodes: backupCodes ?? [] };
}
