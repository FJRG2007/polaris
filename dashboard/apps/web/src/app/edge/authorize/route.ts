/**
 * Edge login authorize endpoint. The co-located edge guard redirects an
 * unauthenticated visitor of a require-login app here; Polaris authenticates them
 * with its normal session, mints a short-lived, host-bound signed edge token, and
 * bounces back to the app's `/edge/callback`, where the guard converts the token
 * into a same-domain cookie. Polaris cannot set a cookie on the app's domain
 * directly (cross-origin), which is why the token travels in the URL for one hop;
 * it is bound to the app host (`aud`) so it is useless anywhere else. Node runtime
 * so it can read the session and sign with the auth secret.
 */

import { loadEnv } from "@polaris/config";
import { signEdgeToken } from "@polaris/core/waf";
import { isManagedDeployHost } from "@/lib/deploy-service";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a minted edge token is valid. After this the visitor re-authenticates,
 *  which requires Polaris to be reachable again. */
const EDGE_TOKEN_TTL_SECONDS = 8 * 60 * 60;

export async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target = url.searchParams.get("redirect");
    // The target must be an absolute http(s) URL for a host this instance actually
    // routes; reject anything else so this endpoint can never be turned into an open
    // redirector or a token oracle that leaks a signed token to an arbitrary site.
    let appOrigin: URL;
    try {
        appOrigin = new URL(target ?? "");
        if (appOrigin.protocol !== "https:" && appOrigin.protocol !== "http:") {
            throw new Error("unsupported scheme");
        }
    } catch {
        return new Response("Invalid redirect", { status: 400 });
    }
    if (!(await isManagedDeployHost(appOrigin.host))) {
        return new Response("Invalid redirect", { status: 400 });
    }

    const session = await getSession();
    if (!session?.user) {
        // Not signed in: send to the Polaris login, preserving the return trip. A
        // relative Location resolves against the public URL (request.url is the
        // internal upstream behind the reverse proxy).
        const back = `/edge/authorize?redirect=${encodeURIComponent(target as string)}`;
        return new Response(null, {
            status: 302,
            headers: { location: `/oauth/login?redirect=${encodeURIComponent(back)}` }
        });
    }

    const secret = loadEnv().POLARIS_AUTH_SECRET;
    const now = Math.floor(Date.now() / 1000);
    const token = signEdgeToken(
        { sub: (session.user as { id: string }).id, aud: appOrigin.host, exp: now + EDGE_TOKEN_TTL_SECONDS },
        secret
    );
    const callback = new URL("/edge/callback", appOrigin);
    callback.searchParams.set("token", token);
    callback.searchParams.set("redirect", target as string);
    return new Response(null, { status: 302, headers: { location: callback.toString() } });
}
