/**
 * Hands the page being rendered its own path, as `x-polaris-path`.
 *
 * Next.js gives a server component no way to read the URL it is rendering, and
 * the session guard needs it to keep a PIN-locked app shut (see
 * `app-lock-service`): a layout persists across navigations inside it, so only
 * a per-request check, made from `requireUser`, sees every screen and every
 * server action (which post to the page they run on). A value the browser
 * sends under that name is overwritten, never trusted.
 */

import { NextResponse, type NextRequest } from "next/server";

const PATH_HEADER = "x-polaris-path";

export function middleware(request: NextRequest) {
    const headers = new Headers(request.headers);
    headers.set(PATH_HEADER, request.nextUrl.pathname);
    return NextResponse.next({ request: { headers } });
}

export const config = {
    // Everything but the API and the build's own files. A path with a dot in
    // it is still matched: an app's screen can end in a file name (Drive),
    // and one left unmatched would carry no path, and no lock.
    matcher: ["/((?!api/|_next/).*)"]
};
