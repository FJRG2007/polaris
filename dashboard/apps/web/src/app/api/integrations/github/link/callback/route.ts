/**
 * Finish linking a GitHub account to the signed-in Polaris account.
 *
 * The state cookie is checked before the code is spent: without it, a link could be
 * completed by sending somebody a URL, and the account that ended up on their
 * profile would be whichever one the sender had authorized.
 *
 * Every outcome ends on the profile with a flag rather than as a bare error page,
 * because this is the last step of something the person started there.
 */

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { GITHUB_LINK_STATE_COOKIE } from "../route";
import { linkGithubIdentity } from "@/lib/github-identity";
import { githubLinkCallbackUrl, identifyGithubUser } from "@/lib/github-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();

    const url = new URL(request.url);
    const profile = new URL("/account", url.origin);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    const expected = request.headers
        .get("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${GITHUB_LINK_STATE_COOKIE}=`))
        ?.slice(GITHUB_LINK_STATE_COOKIE.length + 1);

    const done = (outcome: string): Response => {
        profile.searchParams.set("github", outcome);
        const response = NextResponse.redirect(profile);
        response.cookies.delete(GITHUB_LINK_STATE_COOKIE);
        return response;
    };

    if (!code) return done("cancelled");
    if (!expected || !state || expected !== state) return done("state_error");

    try {
        const account = await identifyGithubUser(code, githubLinkCallbackUrl(url.origin));
        await linkGithubIdentity(user.id, account);
        return done("linked");
    } catch (caught) {
        // A GitHub account already claimed by somebody else is the one refusal
        // worth naming, since the person can do something about it.
        return done(caught instanceof Error && caught.message.includes("already linked") ? "taken" : "error");
    }
}
