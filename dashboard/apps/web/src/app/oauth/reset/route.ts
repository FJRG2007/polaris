/**
 * Session reset. Clears Polaris auth cookies and sends the user to sign in. This
 * is the escape hatch for a cookie that can no longer be verified (for example
 * one signed with a previous POLARIS_AUTH_SECRET), which otherwise surfaces as
 * "Unsupported state or unable to authenticate data": visiting /oauth/reset drops
 * the stale cookie so a fresh sign-in issues a valid one. Node runtime so it can
 * write cookies on the response.
 */

import { cookies } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const store = await cookies();
    // Expire every Polaris cookie (prefix "polaris" - the session token, its
    // cache, any CSRF cookie). Set-Cookie is written straight onto the response so
    // it applies even though we return a raw Response.
    const headers = new Headers({ location: "/oauth/login" });
    for (const cookie of store.getAll()) {
        if (cookie.name.startsWith("polaris")) {
            headers.append("set-cookie", `${cookie.name}=; Path=/; Max-Age=0`);
        }
    }
    // Relative redirect: behind the reverse proxy request.url is the internal
    // http://0.0.0.0:3000 upstream, so an absolute URL built from it points at a
    // dead address. A relative Location resolves against the public URL used.
    return new Response(null, { status: 302, headers });
}
