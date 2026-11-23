/**
 * Server actions that prove or set a password without ever receiving it
 * (docs/chat-e2ee-phase1.md, "Password flows over OPAQUE").
 *
 * The browser runs the OPAQUE steps against `/api/e2ee/keys` (`proof-start`,
 * `set-start`, `set-verify`) and hands the action only the final message of each
 * login. The action finishes those logins itself, so the proof and the new
 * password are bound to the session that runs the action and are spent once.
 */

/** The session this request runs on: a login started on another one (another
 *  browser, a stolen proof replayed elsewhere) never finishes here. */
async function sessionId(): Promise<string | null> {
    return (await backgroundUser())?.sessionId ?? null;
}

import { auth } from "@/lib/auth";
import { withProvenPassword } from "@polaris/auth";
import { randomBytes } from "node:crypto";
import * as opaque from "./opaque-service";
import { passwordLockEnabled } from "./flag";
import { backgroundUser } from "@/lib/session";
import { opaqueFinish, type OpaqueFinish } from "./schemas";

/** Whether this account may prove or set its password over OPAQUE: always with
 *  the password lock on, and with the kill switch only when it is already on
 *  OPAQUE - its password may exist nowhere else, so the switch must never take
 *  the flows away from it. */
export async function opaqueFlowsOpen(userId: string): Promise<boolean> {
    return passwordLockEnabled() || (await opaque.adopted(userId));
}

/** Whether this finish proves the signed-in account's current password. Spends
 *  the login whatever the outcome; never throws. */
export async function provesPassword(userId: string, proof: OpaqueFinish): Promise<boolean> {
    try {
        if (!(await opaqueFlowsOpen(userId))) return false;
        const bind = await sessionId();
        if (!bind) return false;
        await opaque.finishLogin(proof.loginId, "proof", proof.finishLoginRequest, userId, bind);
        return true;
    } catch (caught) {
        if (!(caught instanceof opaque.OpaqueRefusal)) console.error("polaris: a password proof failed:", caught);
        return false;
    }
}

/**
 * Run a better-auth route that insists on the password in its body (arming or
 * removing a second factor) with a proof instead: once the proof checks out,
 * `run` gets a stand-in the account's password check accepts once, for the
 * hash read here after the proof, for 30 s (`withProvenPassword`). Null when the
 * proof does not prove the password; the stand-in never leaves this process.
 */
export async function withPasswordProof<T>(
    userId: string,
    proof: OpaqueFinish,
    run: (standIn: string) => Promise<T>
): Promise<T | null> {
    const hash = await provenPasswordHash(userId, proof);
    return hash ? withProvenPassword(hash, run) : null;
}

/**
 * The account's password hash, read after this proof checked out, for a caller
 * that runs several password checks on one proof: one `withProvenPassword` scope
 * per check, each accepted once. Null when the proof does not prove it.
 */
export async function provenPasswordHash(userId: string, proof: OpaqueFinish): Promise<string | null> {
    if (!(await provesPassword(userId, proof))) return null;
    return opaque.credentialHash(userId);
}

/**
 * Run a check that takes the account password with what the form sent in its
 * place: a typed password goes through as it is (an older client, or an account
 * not on OPAQUE yet), a proof becomes the one-use stand-in `withPasswordProof`
 * hands out, which every password check in this process accepts once. Null when
 * it was a proof that does not prove the password, or neither shape at all.
 */
export async function withPasswordOrProof<T>(
    userId: string,
    given: unknown,
    run: (password: string) => Promise<T>
): Promise<T | null> {
    if (typeof given === "string") return run(given);
    const proof = opaqueFinish.safeParse(given);
    return proof.success ? withPasswordProof(userId, proof.data, run) : null;
}

/**
 * Make the record this finish verified the account's password. The old hash is
 * replaced by the hash of a random secret nobody keeps, so no password at all
 * opens the account through a route that still checks the hash. Never throws.
 */
export async function setPasswordOverOpaque(userId: string, set: OpaqueFinish): Promise<boolean> {
    try {
        if (!(await opaqueFlowsOpen(userId))) return false;
        const bind = await sessionId();
        if (!bind) return false;
        const verified = await opaque.finishSetLogin(set.loginId, set.finishLoginRequest, userId, bind);
        const context = await auth.$context;
        const unusable = await context.password.hash(randomBytes(32).toString("base64url"));
        return await opaque.commitPassword(userId, verified.record, verified.ksfVersion, unusable);
    } catch (caught) {
        if (!(caught instanceof opaque.OpaqueRefusal)) console.error("polaris: setting a password failed:", caught);
        return false;
    }
}
