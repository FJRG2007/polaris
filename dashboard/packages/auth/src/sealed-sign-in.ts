/**
 * A sign-in endpoint only Polaris itself can call, for a way in whose proof
 * happens in the app rather than in better-auth: OPAQUE's two steps, or a phone
 * approving with the number the browser shows.
 *
 * What is left once the app has its proof is issuing the session the same way a
 * password sign-in issues one, which is why it is a better-auth endpoint and not
 * a session row written by hand: the session-create hooks (the enforced identity
 * provider, the sign-in listeners), the sign-in method record and - on a path
 * registered as challenged in auth.ts - the second-factor challenge and the
 * remembered-device pass all key on the path.
 *
 * It refuses any request that arrived over HTTP, twice, so the only caller is
 * Polaris after a proof it accepted. Off the wire it answers 404 whatever the
 * body, so it does not even admit to existing.
 */

import { z } from "zod";
import type { Auth } from "./auth.js";
import type { BetterAuthPlugin } from "better-auth";
import type { IssuedCookie } from "./device-login.js";
import { readIssuedCookies } from "./device-login.js";
import { setSessionCookie } from "better-auth/cookies";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";

export function sealedSignInPlugin(id: string, path: string, endpoint: string): BetterAuthPlugin {
    return {
        id,
        hooks: {
            before: [
                {
                    matcher: (context) => context.path === path,
                    handler: createAuthMiddleware(async (ctx) => {
                        if (!ctx.request) return;
                        throw new APIError("NOT_FOUND", { message: "Not found" });
                    })
                }
            ]
        },
        endpoints: {
            [endpoint]: createAuthEndpoint(
                path,
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

type SealedSignInApi = Record<
    string,
    (input: { body: { userId: string }; headers: Headers; returnHeaders: true }) => Promise<{ headers: Headers }>
>;

export interface SealedSignInResult {
    readonly cookies: readonly IssuedCookie[];
    /** No session was issued: the cookies carry the second-factor challenge. */
    readonly challenged: boolean;
}

const TWO_FACTOR_COOKIE_SUFFIX = "two_factor";

/** Issue the session for an account whose proof the app just accepted. */
export async function issueSealedSignIn(
    auth: Auth,
    endpoint: string,
    userId: string,
    headers: Headers
): Promise<SealedSignInResult> {
    const call = (auth.api as unknown as SealedSignInApi)[endpoint];
    if (!call) throw new Error(`polaris: the sealed sign-in endpoint ${endpoint} is not registered`);
    const { headers: issued } = await call({ body: { userId }, headers, returnHeaders: true });
    const cookies = readIssuedCookies(issued);
    return {
        cookies,
        challenged: cookies.some((cookie) => cookie.name.endsWith(TWO_FACTOR_COOKIE_SUFFIX) && cookie.value !== "")
    };
}
