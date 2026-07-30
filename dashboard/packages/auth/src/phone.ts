/**
 * The phone number a second-factor code can be sent to.
 *
 * One number per account, and it is only a factor once the owner has proved they
 * receive at it: the number is written down first and confirmed second, exactly
 * like an address, because a mistyped digit would otherwise send codes to a
 * stranger for as long as nobody noticed.
 *
 * The confirmation code is six digits, which is guessable in a way a link token
 * is not, so it is hashed with the password hasher, expires quickly, and dies
 * after a handful of wrong tries. Sending it is the caller's job - this package
 * knows what the code is, not what carries it.
 */

import { TWO_FACTOR_CODE_ATTEMPTS, TWO_FACTOR_CODE_TTL_MINUTES } from "@polaris/core";
import { prisma } from "@polaris/db";
import type { Auth } from "./auth.js";
import { hashSecret, verifyAccountPassword, verifySecret } from "./security.js";

/** The number on an account, as every surface reports it. */
export interface UserPhoneView {
    phone: string;
    /** Whether the owner has proved they receive messages at it. */
    verified: boolean;
}

const CODE_TTL_MS = TWO_FACTOR_CODE_TTL_MINUTES * 60 * 1000;

/**
 * A six-digit confirmation code, uniform over the range. Bytes from 250 up are
 * thrown away rather than folded with a modulo, which would make the low digits
 * measurably more likely - a small bias, but the sort that only ever helps
 * whoever is guessing.
 */
function generateCode(): string {
    let digits = "";
    while (digits.length < 6) {
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        for (const byte of bytes) {
            if (byte >= 250 || digits.length === 6) continue;
            digits += String(byte % 10);
        }
    }
    return digits;
}

/** The number on a user's account, or null when they have not set one. */
export async function getUserPhone(userId: string): Promise<UserPhoneView | null> {
    const row = await prisma.userPhone.findUnique({
        where: { userId },
        select: { phone: true, verifiedAt: true }
    });
    return row ? { phone: row.phone, verified: row.verifiedAt !== null } : null;
}

/**
 * Write the number on an account, replacing whatever was there. It lands
 * unverified with no outstanding code, so changing the number can never inherit
 * the confirmation the previous one earned.
 *
 * Re-verifies the password: a number that receives second-factor codes is a way
 * into the account, and a hijacked session must not be able to point it at a
 * phone of its own.
 */
export async function setUserPhone(
    auth: Auth,
    userId: string,
    phone: string,
    currentPassword: string
): Promise<{ error?: string }> {
    if (!(await verifyAccountPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    const cleared = { verifiedAt: null, codeHash: null, codeExpiresAt: null, attempts: 0 };
    await prisma.userPhone.upsert({
        where: { userId },
        create: { userId, phone },
        update: { phone, ...cleared }
    });
    return {};
}

/** Take the number off the account. Re-verifies the password for the same reason
 *  setting it does - the two directions are one control. */
export async function removeUserPhone(
    auth: Auth,
    userId: string,
    currentPassword: string
): Promise<{ error?: string }> {
    if (!(await verifyAccountPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    await prisma.userPhone.deleteMany({ where: { userId } });
    return {};
}

/**
 * Mint a confirmation code for the number on the account and return it for the
 * caller to send. Asking again replaces the outstanding one and resets the
 * guess count, so a code that went to a phone the user no longer holds stops
 * working the moment a new one is asked for.
 */
export async function issuePhoneCode(
    auth: Auth,
    userId: string
): Promise<{ code?: string; phone?: string; error?: string }> {
    const row = await prisma.userPhone.findUnique({ where: { userId }, select: { phone: true, verifiedAt: true } });
    if (!row) return { error: "Add a phone number first." };
    if (row.verifiedAt) return { error: "That number is already confirmed." };
    const code = generateCode();
    await prisma.userPhone.update({
        where: { userId },
        data: {
            codeHash: await hashSecret(auth, code),
            codeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
            attempts: 0
        }
    });
    return { code, phone: row.phone };
}

/**
 * Spend a confirmation code. A wrong one counts against the budget and the code
 * dies once the budget is spent, so a six-digit secret cannot be walked through.
 * A correct one clears the pending state and marks the number proved.
 */
export async function verifyPhoneCode(
    auth: Auth,
    userId: string,
    code: string
): Promise<{ error?: string }> {
    const row = await prisma.userPhone.findUnique({ where: { userId } });
    if (!row?.codeHash || !row.codeExpiresAt) return { error: "Ask for a code first." };
    if (row.codeExpiresAt.getTime() < Date.now()) {
        await prisma.userPhone.update({
            where: { userId },
            data: { codeHash: null, codeExpiresAt: null, attempts: 0 }
        });
        return { error: "That code has expired. Ask for a new one." };
    }
    if (row.attempts >= TWO_FACTOR_CODE_ATTEMPTS) {
        await prisma.userPhone.update({
            where: { userId },
            data: { codeHash: null, codeExpiresAt: null, attempts: 0 }
        });
        return { error: "Too many wrong tries. Ask for a new code." };
    }
    if (!(await verifySecret(auth, row.codeHash, code.trim()))) {
        await prisma.userPhone.update({ where: { userId }, data: { attempts: { increment: 1 } } });
        return { error: "That code is not right." };
    }
    await prisma.userPhone.update({
        where: { userId },
        data: { verifiedAt: new Date(), codeHash: null, codeExpiresAt: null, attempts: 0 }
    });
    return {};
}
