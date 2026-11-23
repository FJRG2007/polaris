/**
 * The phone numbers on an account.
 *
 * An account holds up to MAX_USER_PHONES numbers. Each is only usable once the
 * owner has proved they receive at it: the number is written down first and
 * confirmed second, exactly like an address, because a mistyped digit would
 * otherwise send codes to a stranger for as long as nobody noticed. Any
 * confirmed number signs in with the password; the primary is the one codes are
 * sent to. A confirmed number belongs to one account only.
 *
 * Numbers get reassigned: a carrier hands a cancelled line to somebody new, who
 * then cannot use it anywhere it is still registered. So, as WhatsApp and
 * Signal do (the number goes to whoever enters the code texted to it; Signal's
 * registration lock is the exception, mirrored here by `mayTakeFrom`), a
 * confirmation code is sent to a number whatever account holds it, and whoever
 * enters it gets the number - it is taken off the account that had it. Nothing
 * before that proof differs, so the form still says nothing about which numbers
 * are registered.
 *
 * The confirmation code is six digits, which is guessable in a way a link token
 * is not, so it is hashed with the password hasher, expires quickly, and dies
 * after a handful of wrong tries. Sending it is the caller's job - this package
 * knows what the code is, not what carries it.
 */

import { TWO_FACTOR_CODE_ATTEMPTS, TWO_FACTOR_CODE_TTL_MINUTES } from "@polaris/core";
import { prisma, type Prisma } from "@polaris/db";
import type { Auth } from "./auth.js";
import { hashSecret, verifyAccountPassword, verifySecret } from "./security.js";

/** A number on an account, as every surface reports it. */
export interface UserPhoneView {
    id: string;
    phone: string;
    /** Whether the owner has proved they receive messages at it. */
    verified: boolean;
    /** The number codes are sent to. One per account. */
    primary: boolean;
    /**
     * Confirmed here and on another account too - a pair left from before a
     * number could belong to one account only, which signs in to neither. A new
     * code claims it, exactly as it would a number that was reassigned.
     */
    reconfirm?: boolean;
}

/** How many numbers one account may hold. */
export const MAX_USER_PHONES = 5;

const CODE_TTL_MS = TWO_FACTOR_CODE_TTL_MINUTES * 60 * 1000;

const VIEW_SELECT = { id: true, phone: true, verifiedAt: true, primary: true } as const;
/** The primary first, then in the order they were added. */
const VIEW_ORDER: Prisma.UserPhoneOrderByWithRelationInput[] = [{ primary: "desc" }, { createdAt: "asc" }];

function toView(row: { id: string; phone: string; verifiedAt: Date | null; primary: boolean }): UserPhoneView {
    return { id: row.id, phone: row.phone, verified: row.verifiedAt !== null, primary: row.primary };
}

/**
 * The row an id names on this account, or the primary when no id is given - a
 * caller from before an account could hold several numbers.
 */
async function phoneRow(userId: string, phoneId?: string) {
    return prisma.userPhone.findFirst({
        where: phoneId ? { id: phoneId, userId } : { userId },
        orderBy: VIEW_ORDER
    });
}

/** The rows on other accounts that hold this number confirmed. */
function confirmedElsewhere(client: Prisma.TransactionClient, userId: string, phone: string) {
    return client.userPhone.findMany({
        where: { phone, userId: { not: userId }, verifiedAt: { not: null } },
        select: { id: true, userId: true, primary: true }
    });
}

function isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

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

/**
 * The number codes go to: the account's primary, or null when it has none.
 * Callers that need it confirmed check `verified`.
 */
export async function getUserPhone(userId: string): Promise<UserPhoneView | null> {
    const row = await prisma.userPhone.findFirst({ where: { userId }, select: VIEW_SELECT, orderBy: VIEW_ORDER });
    return row ? toView(row) : null;
}

/** Every number on the account, the primary first. */
export async function listUserPhones(userId: string): Promise<UserPhoneView[]> {
    const rows = await prisma.userPhone.findMany({
        where: { userId },
        select: VIEW_SELECT,
        orderBy: VIEW_ORDER,
        take: MAX_USER_PHONES * 2
    });
    const confirmed = rows.filter((row) => row.verifiedAt !== null).map((row) => row.phone);
    if (confirmed.length === 0) return rows.map(toView);
    const shared = await prisma.userPhone.findMany({
        where: { phone: { in: confirmed }, userId: { not: userId }, verifiedAt: { not: null } },
        select: { phone: true }
    });
    const contested = new Set(shared.map((row) => row.phone));
    return rows.map((row) => ({ ...toView(row), reconfirm: row.verifiedAt !== null && contested.has(row.phone) }));
}

/**
 * Add a number to the account. It lands unconfirmed with no outstanding code,
 * and is the primary only when the account had none.
 *
 * Whether another account already holds the number is not looked at here: the
 * answer would tell whoever is typing that the number is registered. That is
 * settled when the code is entered (see verifyPhoneCode).
 *
 * Re-verifies the password: a number that receives second-factor codes is a way
 * into the account, and a hijacked session must not be able to add a phone of
 * its own.
 */
export async function addUserPhone(
    auth: Auth,
    userId: string,
    phone: string,
    currentPassword: string
): Promise<{ id?: string; error?: string }> {
    if (!(await verifyAccountPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    const held = await prisma.userPhone.findMany({ where: { userId }, select: { phone: true } });
    if (held.some((row) => row.phone === phone)) return { error: "That number is already on your account." };
    if (held.length >= MAX_USER_PHONES) return { error: "You can hold at most 5 phone numbers." };
    // Two adds racing on an empty account would both ask to be the primary; the
    // partial unique index takes one and the other lands as an ordinary number.
    for (const primary of held.length === 0 ? [true, false] : [false]) {
        try {
            const row = await prisma.userPhone.create({ data: { userId, phone, primary }, select: { id: true } });
            return { id: row.id };
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
        }
    }
    return { error: "That number is already on your account." };
}

/**
 * Give the account its next primary once `leaving` is gone: a confirmed number
 * first, then the oldest. Runs inside the caller's transaction.
 */
async function promoteNext(tx: Prisma.TransactionClient, userId: string, leaving: string): Promise<void> {
    const next = await tx.userPhone.findFirst({
        where: { userId, id: { not: leaving } },
        orderBy: [{ verifiedAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
        select: { id: true }
    });
    if (next) await tx.userPhone.update({ where: { id: next.id }, data: { primary: true } });
}

/**
 * Take a number off the account. Re-verifies the password for the same reason
 * adding one does - the two directions are one control. Removing the primary
 * hands it to another number, a confirmed one first. `keepOneConfirmed` refuses
 * to remove the last confirmed number, for an account the instance requires one
 * of.
 */
export async function removeUserPhone(
    auth: Auth,
    userId: string,
    currentPassword: string,
    options: { phoneId?: string; keepOneConfirmed?: boolean } = {}
): Promise<{ error?: string }> {
    if (!(await verifyAccountPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    const row = await phoneRow(userId, options.phoneId);
    if (!row) return { error: "That number is not on your account." };
    if (options.keepOneConfirmed && row.verifiedAt) {
        const others = await prisma.userPhone.count({
            where: { userId, id: { not: row.id }, verifiedAt: { not: null } }
        });
        if (others === 0) return { error: "Your administrator requires a confirmed number. Add another first." };
    }
    await prisma.$transaction(async (tx) => {
        await tx.userPhone.deleteMany({ where: { id: row.id, userId } });
        if (row.primary) await promoteNext(tx, userId, row.id);
    });
    return {};
}

/**
 * Make a confirmed number the one codes go to. An unconfirmed one is refused:
 * sending sign-in codes to a number nobody has proved is what confirming exists
 * to prevent.
 */
export async function promoteUserPhone(userId: string, phoneId: string): Promise<{ error?: string }> {
    const row = await phoneRow(userId, phoneId);
    if (!row) return { error: "That number is not on your account." };
    if (!row.verifiedAt) return { error: "Confirm the number before making it primary." };
    if (row.primary) return {};
    await prisma.$transaction([
        prisma.userPhone.updateMany({ where: { userId, primary: true }, data: { primary: false } }),
        prisma.userPhone.update({ where: { id: row.id }, data: { primary: true } })
    ]);
    return {};
}

/**
 * Mint a confirmation code for a number on the account and return it for the
 * caller to send. Asking again replaces the outstanding one and resets the
 * guess count, so a code that went to a phone the user no longer holds stops
 * working the moment a new one is asked for.
 *
 * The code is minted whether or not another account holds the number: only the
 * person holding the phone can read it, and refusing here would tell whoever
 * typed the number that it is registered. A number already confirmed here gets
 * one only while another account holds it confirmed too (`reconfirm`).
 */
export async function issuePhoneCode(
    auth: Auth,
    userId: string,
    phoneId?: string
): Promise<{ code?: string; phone?: string; error?: string }> {
    const row = await phoneRow(userId, phoneId);
    if (!row) return { error: "Add a phone number first." };
    if (row.verifiedAt && (await confirmedElsewhere(prisma, userId, row.phone)).length === 0) {
        return { error: "That number is already confirmed." };
    }
    const code = generateCode();
    await prisma.userPhone.update({
        where: { id: row.id },
        data: {
            codeHash: await hashSecret(auth, code),
            codeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
            attempts: 0
        }
    });
    return { code, phone: row.phone };
}

/** What deciding whether a number may be taken off another account needs. */
export interface PhoneClaimOptions {
    /**
     * Asked once for every account the number would be taken from. False keeps
     * it there - for an account that would be left with no way to finish a
     * sign-in. Absent means every one may lose it.
     */
    mayTakeFrom?: (userId: string) => Promise<boolean>;
}

/** The answer an account gets when the number stays where it is. */
export const PHONE_KEPT_ELSEWHERE = "This number cannot be confirmed on this account. Use another number.";

/** Thrown inside the claim to undo it when the holders changed under it. */
class HoldersChanged extends Error {}

/**
 * Spend a confirmation code. A wrong one counts against the budget and the code
 * dies once the budget is spent, so a six-digit secret cannot be walked through.
 * A correct one clears the pending state and marks the number proved; it also
 * becomes the primary when the account had no confirmed primary.
 *
 * A correct code is proof of holding the phone, so the number moves here from
 * any other account that had it confirmed, and those accounts come back in
 * `takenFrom` for the caller to tell. One that `mayTakeFrom` refuses keeps it:
 * the code is spent, this account gets PHONE_KEPT_ELSEWHERE - said only to
 * somebody who just proved they hold the phone - and the account that kept it
 * comes back in `keptBy`, because somebody else now receives at its number.
 */
export async function verifyPhoneCode(
    auth: Auth,
    userId: string,
    code: string,
    phoneId?: string,
    options: PhoneClaimOptions = {}
): Promise<{ error?: string; takenFrom?: string[]; keptBy?: string[] }> {
    const row = await phoneRow(userId, phoneId);
    if (!row?.codeHash || !row.codeExpiresAt) return { error: "Ask for a code first." };
    const cleared = { codeHash: null, codeExpiresAt: null, attempts: 0 };
    if (row.codeExpiresAt.getTime() < Date.now()) {
        await prisma.userPhone.update({ where: { id: row.id }, data: cleared });
        return { error: "That code has expired. Ask for a new one." };
    }
    if (row.attempts >= TWO_FACTOR_CODE_ATTEMPTS) {
        await prisma.userPhone.update({ where: { id: row.id }, data: cleared });
        return { error: "Too many wrong tries. Ask for a new code." };
    }
    if (!(await verifySecret(auth, row.codeHash, code.trim()))) {
        await prisma.userPhone.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
        return { error: "That code is not right." };
    }

    const owners = [...new Set((await confirmedElsewhere(prisma, userId, row.phone)).map((held) => held.userId))];
    const kept: string[] = [];
    for (const owner of owners) {
        if (options.mayTakeFrom && !(await options.mayTakeFrom(owner))) kept.push(owner);
    }
    if (kept.length > 0) {
        await prisma.userPhone.update({ where: { id: row.id }, data: cleared });
        return { error: PHONE_KEPT_ELSEWHERE, keptBy: kept };
    }

    try {
        await prisma.$transaction(async (tx) => {
            // Two accounts entering their codes for one number at once would each
            // find nobody else confirmed and both keep it; the lock puts them in
            // a line, and the second takes it from the first.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`polaris.user-phone:${row.phone}`}))`;
            const holders = await confirmedElsewhere(tx, userId, row.phone);
            if (holders.some((held) => !owners.includes(held.userId))) throw new HoldersChanged();
            for (const held of holders) {
                await tx.userPhone.deleteMany({ where: { id: held.id, userId: held.userId } });
                if (held.primary) await promoteNext(tx, held.userId, held.id);
            }
            await tx.userPhone.update({ where: { id: row.id }, data: { verifiedAt: new Date(), ...cleared } });
            if (row.primary) return;
            const primary = await tx.userPhone.findFirst({
                where: { userId, primary: true },
                select: { verifiedAt: true }
            });
            if (primary?.verifiedAt) return;
            await tx.userPhone.updateMany({ where: { userId, primary: true }, data: { primary: false } });
            await tx.userPhone.update({ where: { id: row.id }, data: { primary: true } });
        });
    } catch (error) {
        if (!(error instanceof HoldersChanged)) throw error;
        // Another account confirmed the number between the check and the claim,
        // and nobody asked whether it may lose it. The code is spent.
        await prisma.userPhone.update({ where: { id: row.id }, data: cleared });
        return { error: PHONE_KEPT_ELSEWHERE };
    }
    return owners.length > 0 ? { takenFrom: owners } : {};
}
