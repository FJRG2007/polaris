/**
 * Edge login authorize endpoint. The co-located edge guard redirects an
 * unauthenticated visitor of a require-login app here; Polaris authenticates them
 * with its normal session, mints a short-lived, host-bound signed edge token, and
 * bounces back to the app's `/edge/callback`, where the guard converts the token
 * into a same-domain cookie. Polaris cannot set a cookie on the app's domain
 * directly (cross-origin), which is why the token travels in the URL for one hop;
 * it is bound to the app host (`aud`) so it is useless anywhere else. Node runtime
 * so it can read the session and sign with the auth secret.
 *
 * Being signed in is not always enough: the service's firewall rule can name which
 * users, groups or roles the login admits and which it refuses, each only within a
 * window if the operator set one. That is checked here, against the live rule, and the
 * principals the account resolved to travel in the token so the guard can keep checking
 * it offline afterwards.
 */

import { loadEnv } from "@polaris/config";
import { getSession } from "@/lib/session";
import { resolveWaf } from "@/lib/waf-service";
import { principalsOfUser } from "@polaris/auth";
import { deployAppIdForHost } from "@/lib/deploy-service";
import { EDGE_TOKEN_TTL_SECONDS, principalVerdict, signEdgeToken } from "@polaris/core/waf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const applicationId = await deployAppIdForHost(appOrigin.host);
    if (!applicationId) {
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

    const userId = (session.user as { id: string }).id;
    const now = Math.floor(Date.now() / 1000);
    const [waf, principals] = await Promise.all([resolveWaf(applicationId), principalsOfUser(userId)]);
    const held = new Set(principals.map((entry) => `${entry.principalType}:${entry.principalId}`));
    // Signed in, but this service's firewall names who may reach it and this account is
    // not one of them - or is one of the accounts it refuses. Answered here rather than
    // left to the guard: the guard is where a visitor ends up after this hop, so minting
    // a token it will reject is how a redirect loop starts. It is also the only place
    // that can say why - the guard sees a rule and a token, never an account.
    const verdict = principalVerdict(
        { loginAllowLists: waf.loginAllowLists, loginDeny: waf.loginDeny },
        held,
        now
    );
    if (verdict !== "admitted") {
        return new Response(
            verdict === "refused"
                ? "Your account has been blocked from this service."
                : "Your account does not have access to this service.",
            { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } }
        );
    }

    const secret = loadEnv().POLARIS_AUTH_SECRET;
    const token = signEdgeToken(
        {
            sub: userId,
            aud: appOrigin.host,
            exp: now + EDGE_TOKEN_TTL_SECONDS,
            // When these principals were true. What lets the guard tell a token that
            // predates a membership change from one that reflects it.
            iat: now,
            // Carried so the guard can answer the same question offline on every later
            // request, without Polaris and without a membership lookup at the edge.
            prn: [...held]
        },
        secret
    );
    const callback = new URL("/edge/callback", appOrigin);
    callback.searchParams.set("token", token);
    callback.searchParams.set("redirect", target as string);
    return new Response(null, { status: 302, headers: { location: callback.toString() } });
}
