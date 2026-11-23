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
import { randomBytes } from "node:crypto";
import * as opaque from "./opaque-service";
import { passwordLockEnabled } from "./flag";
import { backgroundUser } from "@/lib/session";
import type { OpaqueFinish } from "./schemas";

/** Whether this finish proves the signed-in account's current password. Spends
 *  the login whatever the outcome; never throws. */
export async function provesPassword(userId: string, proof: OpaqueFinish): Promise<boolean> {
    if (!passwordLockEnabled()) return false;
    try {
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
 * Make the record this finish verified the account's password. The old hash is
 * replaced by the hash of a random secret nobody keeps, so no password at all
 * opens the account through a route that still checks the hash. Never throws.
 */
export async function setPasswordOverOpaque(userId: string, set: OpaqueFinish): Promise<boolean> {
    if (!passwordLockEnabled()) return false;
    try {
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
