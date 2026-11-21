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

import { z } from "zod";
import type { Auth } from "./auth.js";
import type { BetterAuthPlugin } from "better-auth";
import type { IssuedCookie } from "./device-login.js";
import { readIssuedCookies } from "./device-login.js";
import { setSessionCookie } from "better-auth/cookies";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";

export const OPAQUE_SIGN_IN_PATH = "/polaris/opaque-sign-in";

export function opaqueSignInPlugin(): BetterAuthPlugin {
    return {
        id: "polaris-opaque-sign-in",
        hooks: {
            before: [
                {
                    matcher: (context) => context.path === OPAQUE_SIGN_IN_PATH,
                    handler: createAuthMiddleware(async (ctx) => {
                        if (!ctx.request) return;
                        throw new APIError("NOT_FOUND", { message: "Not found" });
                    })
                }
            ]
        },
        endpoints: {
            polarisOpaqueSignIn: createAuthEndpoint(
                OPAQUE_SIGN_IN_PATH,
                { method: "POST", body: z.object({ userId: z.string() }) },
                async (ctx) => {
                    if (ctx.request) throw new APIError("NOT_FOUND", { message: "Not found" });
                    const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
                    if (!user) throw new APIError("UNAUTHORIZED", { message: "That account is no longer here." });
                    const session = await ctx.context.internalAdapter.createSession(user.id);
                    if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Session not created" });
                    ctx.context.setNewSession({ session, user });
                    // Same order as a password sign-in: the cookie exists, and the
                    // two-factor hook takes it back when a challenge is due.
                    await setSessionCookie(ctx, { session, user });
                    return ctx.json({ signedIn: true });
                }
            )
        }
    } satisfies BetterAuthPlugin;
}

interface OpaqueSignInApi {
    polarisOpaqueSignIn(input: {
        body: { userId: string };
        headers: Headers;
        returnHeaders: true;
    }): Promise<{ headers: Headers }>;
}

export interface OpaqueSignInResult {
    readonly cookies: readonly IssuedCookie[];
    /** No session was issued: the cookies carry the second-factor challenge. */
    readonly challenged: boolean;
}

const TWO_FACTOR_COOKIE_SUFFIX = "two_factor";

/** Issue the session for an account whose OPAQUE finish the app just accepted. */
export async function signInWithOpaque(
    auth: Auth,
    userId: string,
    headers: Headers
): Promise<OpaqueSignInResult> {
    const { headers: issued } = await (auth.api as unknown as OpaqueSignInApi).polarisOpaqueSignIn({
        body: { userId },
        headers,
        returnHeaders: true
    });
    const cookies = readIssuedCookies(issued);
    return {
        cookies,
        challenged: cookies.some((cookie) => cookie.name.endsWith(TWO_FACTOR_COOKIE_SUFFIX) && cookie.value !== "")
    };
}
