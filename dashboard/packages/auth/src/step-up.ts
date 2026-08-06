/**
 * Codes that prove an open session is still the person who opened it.
 *
 * Distinct from the sign-in challenge, which better-auth owns and which is
 * driven by a cookie held between the password and the session. There is no
 * challenge here: the session already exists, and what is being asked is whether
 * the human in front of it is the account holder before something irreversible
 * happens. So the code lives on its own, keyed by the account and by what it was
 * asked for, and cannot be spent on anything else.
 *
 * Minted here and sent by the caller, exactly as a phone confirmation is: this
 * package knows how to mint and check a short secret, and nothing about mail
 * channels or messaging bridges.
 *
 * The code is stored the way every low-entropy secret in Polaris is - hashed
 * with the password hasher - with an expiry and a hard cap on wrong guesses, so
 * six digits cannot be walked through even by somebody holding the session.
 */

import { prisma } from "@polaris/db";
import type { Auth } from "./auth.js";
import { randomInt } from "node:crypto";
import { hashSecret, verifySecret } from "./security.js";
import { TWO_FACTOR_CODE_ATTEMPTS, TWO_FACTOR_CODE_TTL_MINUTES } from "@polaris/core";

const TTL_MS = TWO_FACTOR_CODE_TTL_MINUTES * 60 * 1000;

/**
 * What a code was asked for, folded into the key it is stored under.
 *
 * A code minted to delete one organization must not delete another, and a code
 * minted for anything must not stand in for a code somebody is waiting on
 * elsewhere. Naming the act is what makes both true without a second table.
 */
function keyFor(userId: string, purpose: string): string {
    return `step-up:${purpose}:${userId}`;
}

/** The hash and the guesses spent so far, in the one column a Verification row
 *  has for a payload. */
interface Pending {
    hash: string;
    attempts: number;
}

function readPending(value: string): Pending | null {
    try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== "object" || parsed === null) return null;
        const { hash, attempts } = parsed as Partial<Pending>;
        if (typeof hash !== "string" || typeof attempts !== "number") return null;
        return { hash, attempts };
    } catch {
        return null;
    }
}

/** Six digits, uniformly drawn, leading zeroes kept - the same shape every other
 *  code in Polaris is typed as. */
function generateCode(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Mint a code for one act and return it for the caller to deliver.
 *
 * Asking again replaces the outstanding code and resets the guess count, so a
 * code that went to a mailbox the account no longer reads stops working the
 * moment a new one is asked for.
 */
export async function issueStepUpCode(auth: Auth, userId: string, purpose: string): Promise<string> {
    const identifier = keyFor(userId, purpose);
    const code = generateCode();
    const value = JSON.stringify({ hash: await hashSecret(auth, code), attempts: 0 } satisfies Pending);
    await prisma.verification.deleteMany({ where: { identifier } });
    await prisma.verification.create({
        data: { identifier, value, expiresAt: new Date(Date.now() + TTL_MS) }
    });
    return code;
}

/**
 * Spend a code. A wrong one costs a guess and the code dies once the budget is
 * spent; a right one is deleted, so it works exactly once.
 *
 * Returns the reason rather than throwing, because every one of these is a
 * sentence the person typing the code needs to read.
 */
export async function verifyStepUpCode(
    auth: Auth,
    userId: string,
    purpose: string,
    code: string
): Promise<{ error?: string }> {
    const identifier = keyFor(userId, purpose);
    const row = await prisma.verification.findFirst({
        where: { identifier },
        orderBy: { createdAt: "desc" },
        select: { id: true, value: true, expiresAt: true }
    });
    if (!row) return { error: "Ask for a code first." };

    const pending = readPending(row.value);
    if (!pending || row.expiresAt.getTime() < Date.now()) {
        await prisma.verification.delete({ where: { id: row.id } });
        return { error: "That code has expired. Ask for a new one." };
    }
    if (pending.attempts >= TWO_FACTOR_CODE_ATTEMPTS) {
        await prisma.verification.delete({ where: { id: row.id } });
        return { error: "Too many wrong tries. Ask for a new code." };
    }
    if (!(await verifySecret(auth, pending.hash, code.trim()))) {
        await prisma.verification.update({
            where: { id: row.id },
            data: { value: JSON.stringify({ ...pending, attempts: pending.attempts + 1 } satisfies Pending) }
        });
        return { error: "That code is not right." };
    }

    await prisma.verification.delete({ where: { id: row.id } });
    return {};
}

/** Drop an outstanding code without spending it - for a confirmation the person
 *  walked away from, so nothing they were sent stays live for ten minutes. */
export async function discardStepUpCode(userId: string, purpose: string): Promise<void> {
    await prisma.verification.deleteMany({ where: { identifier: keyFor(userId, purpose) } });
}
