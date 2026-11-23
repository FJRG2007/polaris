/**
 * Signing in with no password: the account's phone approves, picking the number
 * the browser shows, behind the phone's own screen lock.
 *
 * The proof lives in the app (`lib/mobile/phone-sign-in.ts`); this is only the
 * session, issued through the same sealed endpoint the OPAQUE password sign-in
 * uses, so every session-create hook applies exactly as it does there. It is
 * not a challenged path: the approval is already two factors - the phone's
 * device key and its screen lock - the way a passkey with user verification is,
 * and as Microsoft Authenticator's passwordless sign-in counts it.
 */

import type { Auth } from "./auth.js";
import type { BetterAuthPlugin } from "better-auth";
import { issueSealedSignIn, sealedSignInPlugin, type SealedSignInResult } from "./sealed-sign-in.js";

export const PHONE_SIGN_IN_PATH = "/polaris/phone-sign-in";
const ENDPOINT = "polarisPhoneSignIn";

export function phoneSignInPlugin(): BetterAuthPlugin {
    return sealedSignInPlugin("polaris-phone-sign-in", PHONE_SIGN_IN_PATH, ENDPOINT);
}

/** Issue the session for an account whose phone just approved this browser. */
export async function signInWithPhone(auth: Auth, userId: string, headers: Headers): Promise<SealedSignInResult> {
    return issueSealedSignIn(auth, ENDPOINT, userId, headers);
}
