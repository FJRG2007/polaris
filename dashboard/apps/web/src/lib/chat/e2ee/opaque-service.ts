/**
 * The server half of the OPAQUE password: the instance's server setup, each
 * account's registration record, and the login states between the two steps.
 * Used for three things - signing in, verifying a record just made during the
 * adoption, and unlocking the account key's password envelope.
 *
 * What makes the move to OPAQUE impossible to lock anybody out with
 * (docs/chat-e2ee-phase1.md, "Sign-in migration"):
 *
 * - A record signs in only once `verifiedAt` is set, which happens only after a
 *   full OPAQUE login against that exact record succeeded.
 * - A record signs in only while `passwordTag` matches a keyed fingerprint of
 *   the account's current better-auth password hash. Every way a password
 *   changes - the account page, a reset link, an administrator, a recovery -
 *   rewrites that hash, so the record retires itself with no hook on any of
 *   them, and the next sign-in goes the old way and adopts again.
 * - The better-auth hash is never touched here. Anything that fails leaves the
 *   account on the old path, and the next sign-in tries again.
 *
 * The server setup is sealed with `encryptSecret` under POLARIS_MASTER_KEY, the
 * way every other stored secret in Polaris is (automation secrets, CalDAV app
 * passwords, share tokens), and made on first use so no install writes it.
 */

import { loadEnv } from "@polaris/config";
import { prisma, Prisma } from "@polaris/db";
import { createHash, timingSafeEqual } from "node:crypto";
import * as opaque from "@polaris/chat-crypto/opaque-server";
import { clientIp } from "@/lib/request-context";
import { passwordOpensRecordOffThread } from "./clear-password-pool";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { PASSWORD_KSF_CURRENT, passwordKsf, type PasswordKsfVersion } from "@polaris/chat-crypto/password-lock";
import { CredentialDecryptError, decryptSecret, encryptSecret, secretFingerprint } from "@polaris/storage";

const SETUP_ID = "default";
const LOGIN_TTL_MS = 2 * 60 * 1000;
const PASSWORD_TAG_SCOPE = "chat-e2ee/opaque-password";
const UNKNOWN_ID_SCOPE = "chat-e2ee/opaque-unknown-account";

/** `proof` proves the signed-in account's current password to a server action
 *  (step-up, change password) without the password; `set` verifies a record for
 *  a NEW password before it replaces the current one (`startSetLogin`). */
export type LoginPurpose = "sign-in" | "verify" | "unlock" | "proof" | "set";

/** Why an OPAQUE step was refused. One shape for every cause, so a reply never
 *  tells a wrong password from an unknown address or a stale login. */
export class OpaqueRefusal extends Error {
    constructor() {
        super("refused");
        this.name = "OpaqueRefusal";
    }
}

let setupLoad: Promise<string> | null = null;

async function loadOrCreateSetup(): Promise<string> {
    const masterKey = loadEnv().POLARIS_MASTER_KEY;
    const row = await prisma.opaqueServerSetup.findUnique({ where: { id: SETUP_ID } });
    if (row) {
        try {
            return decryptSecret(
                { ciphertext: Buffer.from(row.ciphertext), nonce: Buffer.from(row.nonce), keyId: row.keyId },
                masterKey
            );
        } catch (caught) {
            if (!(caught instanceof CredentialDecryptError)) throw caught;
            // The master key was replaced. No record made under the old setup
            // can ever be used again, so they go with it: every account falls
            // back to its password hash and adopts again on its next sign-in.
            await prisma.$transaction([
                prisma.opaqueRecord.deleteMany({}),
                prisma.opaqueServerSetup.delete({ where: { id: SETUP_ID } })
            ]);
        }
    }
    const setup = await opaque.createServerSetup();
    const blob = encryptSecret(setup, masterKey);
    try {
        await prisma.opaqueServerSetup.create({
            data: { id: SETUP_ID, ciphertext: blob.ciphertext, nonce: blob.nonce, keyId: blob.keyId }
        });
        return setup;
    } catch (caught) {
        // Another process made it first; theirs is the one.
        if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === "P2002")
            return loadOrCreateSetup();
        throw caught;
    }
}

/** The instance's OPAQUE server setup, made and sealed on first use. */
export async function serverSetup(): Promise<string> {
    setupLoad ??= loadOrCreateSetup().catch((caught: unknown) => {
        setupLoad = null;
        throw caught;
    });
    return setupLoad;
}

/** Forget the cached setup. Tests only. */
export function resetServerSetupCache(): void {
    setupLoad = null;
}

/** The account's better-auth password hash, or null without one. */
export async function credentialHash(userId: string): Promise<string | null> {
    const account = await prisma.account.findFirst({
        where: { userId, providerId: "credential" },
        select: { password: true }
    });
    return account?.password ?? null;
}

export function passwordTag(hash: string): string {
    return secretFingerprint(hash, PASSWORD_TAG_SCOPE, loadEnv().POLARIS_MASTER_KEY);
}

function sameTag(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

function digest(record: string): string {
    return createHash("sha256").update(record).digest("hex");
}

/**
 * The record an exchange may use: it exists, it still belongs to the current
 * password, and - for a sign-in or an unlock - it has been verified.
 */
export async function usableRecord(
    userId: string,
    purpose: LoginPurpose
): Promise<{ record: string; ksfVersion: PasswordKsfVersion } | null> {
    const [row, hash] = await Promise.all([
        prisma.opaqueRecord.findUnique({
            where: { userId },
            select: { record: true, passwordTag: true, verifiedAt: true, ksfVersion: true }
        }),
        credentialHash(userId)
    ]);
    if (!row || !hash || !sameTag(row.passwordTag, passwordTag(hash))) return null;
    if (purpose !== "verify" && !row.verifiedAt) return null;
    return { record: row.record, ksfVersion: row.ksfVersion === 1 ? 1 : 2 };
}

/** Checks in the clear an account may fail in a row, and an address may make, per window. */
const CLEAR_WINDOW_MS = 15 * 60 * 1000;
const CLEAR_PER_ACCOUNT = 10;
const CLEAR_PER_ADDRESS = 60;

/**
 * Whether the per-account and per-address limits leave room for one more
 * check in the clear. The account's count is of failures in a row (a right
 * password clears it), so typing it on the lock screen all day never runs
 * out; the address's is of every check. Read before the Argon2id, so a flood
 * of wrong passwords is refused for the cost of a counter.
 */
async function clearCheckAllowed(userId: string): Promise<boolean> {
    let address: string | undefined;
    try {
        address = await clientIp();
    } catch {
        // Outside a request (a background check): only the account counts.
    }
    const results = await Promise.all([
        rateLimit(`opaque-clear:${userId}`, CLEAR_PER_ACCOUNT, CLEAR_WINDOW_MS),
        ...(address ? [rateLimit(`opaque-clear-address:${address}`, CLEAR_PER_ADDRESS, CLEAR_WINDOW_MS)] : [])
    ]);
    return results.every((result) => result.ok);
}

/**
 * Whether a password handed over in the clear is the one an account set over
 * OPAQUE (`commitPassword`), given only the hash the caller compared it to -
 * which is all better-auth's password check has. Such an account's hash opens
 * for nothing, so without this every route that still takes a password (an old
 * client's sign-in, arming a second factor, the lock screen, a quick PIN)
 * would refuse its owner. Only a verified record still tagged with exactly this
 * hash, and still the account's current one, is tried, within the limits
 * above, on a pool thread (`clear-password-pool.ts`). The caller pads a
 * mismatch to `checkFloorMs`, so how long this took says nothing. Never throws.
 */
export async function passwordOpensHashlessAccount(hash: string, password: string): Promise<boolean> {
    try {
        if (!hash || !password) return false;
        const row = await prisma.opaqueRecord.findFirst({
            where: { passwordTag: passwordTag(hash), verifiedAt: { not: null } },
            select: { userId: true }
        });
        if (!row) return false;
        // Re-read through the tag of the account's CURRENT hash, so a record
        // retired by a later password write is never tried.
        const usable = await usableRecord(row.userId, "sign-in");
        if (!usable) return false;
        if (!(await clearCheckAllowed(row.userId))) return false;
        const opens = await passwordOpensRecordOffThread({
            serverSetup: await serverSetup(),
            userId: row.userId,
            record: usable.record,
            password,
            keyStretching: passwordKsf(usable.ksfVersion)
        });
        if (opens) await resetRateLimit(`opaque-clear:${row.userId}`);
        return opens;
    } catch (caught) {
        console.error("polaris: checking a password against its OPAQUE record failed:", caught);
        return false;
    }
}

/** Whether the account has already moved to OPAQUE for its current password. */
export async function adopted(userId: string): Promise<boolean> {
    return (await usableRecord(userId, "sign-in")) !== null;
}

/** The account an address names, or a stable stand-in id for one that names
 *  none - so the identity a start hands back cannot be used to probe addresses. */
export async function identityFor(email: string): Promise<{ userId: string; known: boolean }> {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) return { userId: user.id, known: true };
    const hex = secretFingerprint(email, UNKNOWN_ID_SCOPE, loadEnv().POLARIS_MASTER_KEY)
        .replace(/[^0-9a-f]/gi, "")
        .padEnd(32, "0")
        .slice(0, 32);
    const userId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return { userId, known: false };
}

/** Step one of a login. Runs the same for an account with no usable record, an
 *  unknown address and a real one, so the reply carries nothing to tell apart:
 *  with no record it names the current profile, the one a record made today has. */
export async function startLogin(
    identity: { userId: string; known: boolean },
    purpose: LoginPurpose,
    startLoginRequest: string,
    /** The session a proof is for; its finish must come from the same one. */
    bind?: string
): Promise<{ loginId: string; loginResponse: string; ksfVersion: PasswordKsfVersion }> {
    const usable = identity.known ? await usableRecord(identity.userId, purpose) : null;
    const record = usable?.record ?? null;
    const step = await opaque.startLogin(await serverSetup(), identity.userId, record, startLoginRequest);
    const row = await prisma.opaqueLogin.create({
        data: {
            userId: identity.known && record ? identity.userId : null,
            purpose,
            state: JSON.stringify({ s: step.serverLoginState, r: record ? digest(record) : null, b: bind }),
            expiresAt: new Date(Date.now() + LOGIN_TTL_MS)
        },
        select: { id: true }
    });
    return {
        loginId: row.id,
        loginResponse: step.loginResponse,
        ksfVersion: usable?.ksfVersion ?? PASSWORD_KSF_CURRENT
    };
}

/**
 * Step two. Takes the login state (single use: whoever deletes it owns it), and
 * returns the account only when the client proved it knows the password.
 * `expectUserId` pins an unlock to the signed-in account.
 */
export async function finishLogin(
    loginId: string,
    purpose: LoginPurpose,
    /** Absent when the client's own finish already failed (a wrong password):
     *  the login is still spent here, so the attempt counts like any other. */
    finishLoginRequest: string | undefined,
    expectUserId?: string,
    expectBind?: string
): Promise<{ userId: string; recordDigest: string }> {
    const { userId, state } = await takeLogin(loginId, purpose, expectUserId, expectBind);
    if (typeof state.r !== "string" || finishLoginRequest === undefined) throw new OpaqueRefusal();
    if (!(await opaque.finishLogin(userId, state.s, finishLoginRequest))) throw new OpaqueRefusal();
    // A password changed between the two steps retires the record mid-login:
    // the proof was against a password that no longer opens the account.
    if (purpose !== "verify" && purpose !== "set") {
        const current = await usableRecord(userId, purpose);
        if (!current || digest(current.record) !== state.r) throw new OpaqueRefusal();
    }
    return { userId, recordDigest: state.r };
}

/** Spend a login state (single use: whoever deletes it owns it) and read it. */
async function takeLogin(
    loginId: string,
    purpose: LoginPurpose,
    expectUserId?: string,
    expectBind?: string
): Promise<{ userId: string; state: { s: string; r?: unknown; p?: unknown; k?: unknown } }> {
    const row = await prisma.opaqueLogin.findUnique({ where: { id: loginId } });
    if (!row) throw new OpaqueRefusal();
    const { count } = await prisma.opaqueLogin.deleteMany({ where: { id: loginId } });
    if (count !== 1) throw new OpaqueRefusal();
    if (row.purpose !== purpose || row.expiresAt.getTime() <= Date.now() || !row.userId)
        throw new OpaqueRefusal();
    if (expectUserId !== undefined && row.userId !== expectUserId) throw new OpaqueRefusal();
    let state: { s?: unknown; r?: unknown; p?: unknown; k?: unknown; b?: unknown };
    try {
        state = JSON.parse(row.state) as typeof state;
    } catch {
        throw new OpaqueRefusal();
    }
    if (typeof state.s !== "string") throw new OpaqueRefusal();
    // A login bound to a session finishes only on that session, and one that
    // was not bound never satisfies a caller that asks for a binding.
    if ((state.b !== undefined || expectBind !== undefined) && state.b !== expectBind) throw new OpaqueRefusal();
    return { userId: row.userId, state: { ...state, s: state.s } };
}

/**
 * Step one of the login that verifies a record for a NEW password, made by the
 * signed-in client from a registration this server answered. The record is not
 * stored anywhere an exchange could use it: it waits inside the login state, and
 * only `finishSetLogin` - a full OPAQUE login against it - hands it back to be
 * committed. So a record that would not open is never written over a working one.
 */
export async function startSetLogin(
    userId: string,
    record: string,
    ksfVersion: PasswordKsfVersion,
    startLoginRequest: string,
    bind: string
): Promise<{ loginId: string; loginResponse: string; ksfVersion: PasswordKsfVersion }> {
    const step = await opaque.startLogin(await serverSetup(), userId, record, startLoginRequest);
    const row = await prisma.opaqueLogin.create({
        data: {
            userId,
            purpose: "set",
            state: JSON.stringify({ s: step.serverLoginState, r: digest(record), p: record, k: ksfVersion, b: bind }),
            expiresAt: new Date(Date.now() + LOGIN_TTL_MS)
        },
        select: { id: true }
    });
    return { loginId: row.id, loginResponse: step.loginResponse, ksfVersion };
}

/** Step two: the record it verified, once the client proved it opens. */
export async function finishSetLogin(
    loginId: string,
    finishLoginRequest: string | undefined,
    userId: string,
    bind: string
): Promise<{ record: string; ksfVersion: PasswordKsfVersion }> {
    const { state } = await takeLogin(loginId, "set", userId, bind);
    if (typeof state.p !== "string" || (state.k !== 1 && state.k !== 2) || finishLoginRequest === undefined)
        throw new OpaqueRefusal();
    if (!(await opaque.finishLogin(userId, state.s, finishLoginRequest))) throw new OpaqueRefusal();
    return { record: state.p, ksfVersion: state.k };
}

/**
 * Make a verified record the account's password. The server never saw the new
 * password, so the better-auth hash becomes a hash of a random secret nobody
 * holds: `/sign-in/email` and every check still made against the hash refuse
 * any password, and the record - tagged with that new hash - is the only way in.
 * Any later write of a real hash (an old client's reset, an administrator)
 * retires the record by its tag, exactly as before. One transaction, so the
 * account is never left with neither. False when the account has no password
 * account to replace.
 */
export async function commitPassword(
    userId: string,
    record: string,
    ksfVersion: PasswordKsfVersion,
    unusableHash: string
): Promise<boolean> {
    const tag = passwordTag(unusableHash);
    return prisma.$transaction(async (tx) => {
        const { count } = await tx.account.updateMany({
            where: { userId, providerId: "credential" },
            data: { password: unusableHash }
        });
        if (count === 0) return false;
        await tx.opaqueRecord.upsert({
            where: { userId },
            create: { userId, record, passwordTag: tag, ksfVersion, verifiedAt: new Date() },
            update: { record, passwordTag: tag, ksfVersion, verifiedAt: new Date() }
        });
        return true;
    });
}

/** The adoption's registration step one, answered for any address alike. */
export async function registrationResponse(userId: string, registrationRequest: string): Promise<string> {
    return opaque.registrationResponse(await serverSetup(), userId, registrationRequest);
}

/**
 * Store a record made during the adoption, unverified. Refused - as a no-op -
 * when the account already has a verified record for its current password, so
 * a second sign-in racing the first can never replace a record in use.
 */
export async function storePendingRecord(
    userId: string,
    hash: string,
    record: string,
    ksfVersion: PasswordKsfVersion = 1
): Promise<void> {
    const tag = passwordTag(hash);
    const existing = await prisma.opaqueRecord.findUnique({
        where: { userId },
        select: { passwordTag: true, verifiedAt: true }
    });
    if (existing?.verifiedAt && sameTag(existing.passwordTag, tag)) return;
    await prisma.opaqueRecord.upsert({
        where: { userId },
        create: { userId, record, passwordTag: tag, ksfVersion },
        update: { record, passwordTag: tag, ksfVersion, verifiedAt: null }
    });
}

/** Mark the record verified - only if it is still the exact one the login ran
 *  against. A concurrent adoption that replaced it in between is left alone. */
export async function markVerified(userId: string, recordDigest: string): Promise<boolean> {
    const row = await prisma.opaqueRecord.findUnique({ where: { userId }, select: { record: true } });
    if (!row || digest(row.record) !== recordDigest) return false;
    const { count } = await prisma.opaqueRecord.updateMany({
        where: { userId, record: row.record },
        data: { verifiedAt: new Date() }
    });
    return count === 1;
}

/** Expired login states. Called from the routes; cheap with the index. */
export async function sweepLogins(now: Date = new Date()): Promise<number> {
    const { count } = await prisma.opaqueLogin.deleteMany({ where: { expiresAt: { lte: now } } });
    return count;
}
