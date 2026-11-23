/**
 * Signing in with a password proved over OPAQUE (RFC 9807) instead of sent.
 *
 * The proof happens in the app (`lib/chat/e2ee/opaque-sign-in.ts`): the browser
 * and the server run the two OPAQUE steps, and only a finish the server accepts
 * reaches this endpoint. What is left here is issuing the session the same way
 * a password sign-in issues one, which is why it is a better-auth endpoint and
 * not a session row written by hand - exactly the reasoning, and the sealing,
 * of the connected-account sign-in beside it:
 *
 * - The second-factor challenge, the remembered-device pass, the sign-in method
 *   record ("password") and the enforced-identity-provider refusal are all
 *   hooks keyed by path, and this path is registered with each of them in
 *   auth.ts. It is always challenged, like `/sign-in/email`: the challenge hook
 *   itself decides from the account whether a second factor is armed.
 * - It refuses any request that arrived over HTTP, twice, so the only caller is
 *   Polaris after a verified OPAQUE finish. Off the wire it answers 404 whatever
 *   the body, so it does not even admit to existing.
 *
 * Behind the chat end-to-end encryption rollout flag: the app never calls it
 * while the flag is off, so the password sign-in is unchanged byte for byte.
 */

import type { Auth } from "./auth.js";
import type { BetterAuthPlugin } from "better-auth";
import { issueSealedSignIn, sealedSignInPlugin, type SealedSignInResult } from "./sealed-sign-in.js";

export const OPAQUE_SIGN_IN_PATH = "/polaris/opaque-sign-in";
const ENDPOINT = "polarisOpaqueSignIn";

export function opaqueSignInPlugin(): BetterAuthPlugin {
    return sealedSignInPlugin("polaris-opaque-sign-in", OPAQUE_SIGN_IN_PATH, ENDPOINT);
}

export type OpaqueSignInResult = SealedSignInResult;

/** Issue the session for an account whose OPAQUE finish the app just accepted. */
export async function signInWithOpaque(
    auth: Auth,
    userId: string,
    headers: Headers
): Promise<OpaqueSignInResult> {
    return issueSealedSignIn(auth, ENDPOINT, userId, headers);
}
