/**
 * Start linking the signed-in Polaris account to a GitHub account.
 *
 * This sends the person to GitHub's own authorization screen and nowhere else: the
 * point of the round trip is that Polaris learns who they are from GitHub rather
 * than from something typed into a form. A random state is stored in an httpOnly
 * cookie and echoed back, so a link cannot be started on somebody else's behalf.
 *
 * No scopes are requested. Reading the identity of whoever authorized needs none,
 * and the repositories a pool serves are reached with the installation's own
 * credentials, never with theirs.
 */

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { getGithubUserAuth, githubLinkCallbackUrl } from "@/lib/github-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GITHUB_LINK_STATE_COOKIE = "gh_link_state";

export async function GET(request: Request): Promise<Response> {
    await requireUser();

    const origin = new URL(request.url).origin;
    const back = new URL("/account", origin);

    const auth = await getGithubUserAuth();
    if (!auth) {
        back.searchParams.set("github", "unavailable");
        return NextResponse.redirect(back);
    }

    const state = randomBytes(16).toString("hex");
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", auth.clientId);
    authorize.searchParams.set("redirect_uri", githubLinkCallbackUrl(origin));
    authorize.searchParams.set("state", state);

    const response = NextResponse.redirect(authorize);
    response.cookies.set(GITHUB_LINK_STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: "lax",
        secure: origin.startsWith("https:"),
        path: "/",
        maxAge: 600
    });
    return response;
}
