/**
 * Signing in with an outside account somebody has already linked.
 *
 * The identity is proved elsewhere: the app runs the provider's own round trip,
 * matches the account it names against the links it holds, and only then asks
 * for a session. What is left here is issuing that session the same way every
 * other sign-in issues one - which is exactly why it is a better-auth endpoint
 * and not a session row written by hand.
 *
 * Going through better-auth is what keeps the gates on. The second-factor
 * challenge is a hook on the endpoint that creates a session, so an account with
 * an authenticator armed is challenged here as well; the sign-in is recorded as
 * the service that proved it; the remembered-device pass rotates. A session
 * created beside all that would have quietly skipped every one of them.
 *
 * The endpoint is sealed off from the network the same way the device flow is:
 * this is Polaris's own callback talking to Polaris, and the rules that make it
 * safe - which provider, whose link, whether either side allows it - live in the
 * app. An endpoint reachable over HTTP would be a way around all three, and this
 * one takes a user id and asks for nothing else.
 */

import { z } from "zod";
import type { Auth } from "./auth.js";
import type { BetterAuthPlugin } from "better-auth";
import type { IssuedCookie } from "./device-login.js";
import { readIssuedCookies } from "./device-login.js";
import { setSessionCookie } from "better-auth/cookies";
import { APIError, createAuthEndpoint } from "better-auth/api";

/** Where the sealed endpoint answers. Exported because the hooks that gate and
 *  describe a sign-in match on it. */
export const CONNECTION_SIGN_IN_PATH = "/polaris/connection-sign-in";

/**
 * The endpoint that turns "this person owns that linked account" into a session.
 *
 * Refuses a request that arrived over HTTP: `ctx.request` is set only then, and
 * left undefined by a server-side `auth.api` call, which is the same line the
 * device flow draws between Polaris's own actions and anything else.
 */
export function connectionSignInPlugin(): BetterAuthPlugin {
    return {
        id: "polaris-connection-sign-in",
        endpoints: {
            polarisConnectionSignIn: createAuthEndpoint(
                CONNECTION_SIGN_IN_PATH,
                {
                    method: "POST",
                    body: z.object({
                        userId: z.string(),
                        /** The service that proved it, for the session's own record. */
                        provider: z.string()
                    })
                },
                async (ctx) => {
                    if (ctx.request) throw new APIError("NOT_FOUND", { message: "Not found" });

                    const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
                    // The account was read moments ago to match the link, so this is
                    // a deleted account rather than a bad request - and either way
                    // nothing is said about which.
                    if (!user) throw new APIError("UNAUTHORIZED", { message: "That account is no longer here." });

                    const session = await ctx.context.internalAdapter.createSession(user.id);
                    if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Session not created" });

                    ctx.context.setNewSession({ session, user });
                    // Set here rather than in a hook, so the order matches a
                    // password sign-in: the cookie exists, and the two-factor hook
                    // takes it back again when a challenge is due.
                    await setSessionCookie(ctx, { session, user });
                    return ctx.json({ signedIn: true });
                }
            )
        }
    } satisfies BetterAuthPlugin;
}

/** The endpoint as this package calls it. Written out for the reason the device
 *  flow's is: the endpoint's inferred type carries better-auth's own nested zod,
 *  which this package cannot name in the declarations it emits. */
interface ConnectionSignInApi {
    polarisConnectionSignIn(input: {
        body: { userId: string; provider: string };
        headers: Headers;
        returnHeaders: true;
    }): Promise<{ headers: Headers }>;
}

/** How a provider sign-in ended. `challenged` means no session was issued: the
 *  account has a second factor armed, and what the cookies carry is the
 *  challenge it has to answer first. */
export interface ConnectionSignInResult {
    readonly cookies: readonly IssuedCookie[];
    readonly challenged: boolean;
}

/** better-auth's own name for the cookie that names a challenge in flight. */
const TWO_FACTOR_COOKIE_SUFFIX = "two_factor";

/**
 * Sign somebody in on the strength of a linked account, and hand back the
 * cookies that do it.
 *
 * The caller owns the response, so nothing here touches one. The cookies come
 * from better-auth itself and are only carried across; whether they open a
 * session or a challenge is read off them rather than guessed, so the caller can
 * send the browser straight to the screen that is actually waiting for it.
 */
export async function signInWithConnection(
    auth: Auth,
    input: { userId: string; provider: string },
    headers: Headers
): Promise<ConnectionSignInResult> {
    const { headers: issued } = await (auth.api as unknown as ConnectionSignInApi).polarisConnectionSignIn({
        body: { userId: input.userId, provider: input.provider },
        headers,
        returnHeaders: true
    });
    const cookies = readIssuedCookies(issued);
    return {
        cookies,
        challenged: cookies.some((cookie) => cookie.name.endsWith(TWO_FACTOR_COOKIE_SUFFIX) && cookie.value !== "")
    };
}
