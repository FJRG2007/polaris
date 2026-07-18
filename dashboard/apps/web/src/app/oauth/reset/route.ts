/**
 * Session reset. Clears Polaris auth cookies and sends the user to sign in. This
 * is the escape hatch for a cookie that can no longer be verified (for example
 * one signed with a previous POLARIS_AUTH_SECRET), which otherwise surfaces as
 * "Unsupported state or unable to authenticate data": visiting /oauth/reset drops
 * the stale cookie so a fresh sign-in issues a valid one. Node runtime so it can
 * write cookies on the response.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const store = await cookies();
    for (const cookie of store.getAll()) {
        // The cookiePrefix is "polaris" (see @polaris/auth), so this covers the
        // session token, its cache, and any CSRF cookie better-auth set.
        if (cookie.name.startsWith("polaris")) store.delete(cookie.name);
    }
    return NextResponse.redirect(new URL("/oauth/login", request.url));
}
