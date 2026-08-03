/**
 * Both halves of linking an account, shared by every provider's routes.
 *
 * A random state is stored in an httpOnly cookie and echoed back, so a link
 * cannot be started on somebody else's behalf: without it, sending somebody a
 * callback URL would put the sender's account on their profile. The provider is
 * carried in the cookie beside the state, so a code minted for one service can
 * never be spent as another.
 *
 * Every outcome ends back on the connections screen with a flag rather than as a
 * bare error page, because this is the last step of something the person started
 * there.
 */

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { findConnectionProvider } from "./providers";
import { ConnectionClaimedError, ConnectionLimitError, saveConnection } from "./store";
import { connectionAuthorizeUrl, connectionCallbackUrl, connectionOAuthClient, exchangeConnectionCode } from "./oauth";

const STATE_COOKIE = "polaris_connection_state";
const BACK_TO = "/account/connections";

/** What the round trip came back with, as the screen reads it. */
export type LinkOutcome = "linked" | "cancelled" | "state_error" | "taken" | "limit" | "unavailable" | "error";

function backTo(origin: string, provider: string, outcome: LinkOutcome): URL {
    const url = new URL(BACK_TO, origin);
    url.searchParams.set("provider", provider);
    url.searchParams.set("connection", outcome);
    return url;
}

/** Send somebody to the provider's own authorization screen, and nowhere else. */
export async function startConnectionLink(request: Request, provider: string): Promise<Response> {
    await requireUser();

    const origin = new URL(request.url).origin;
    if (!findConnectionProvider(provider)) return NextResponse.redirect(backTo(origin, provider, "unavailable"));

    const client = await connectionOAuthClient(provider);
    if (!client) return NextResponse.redirect(backTo(origin, provider, "unavailable"));

    const state = randomBytes(16).toString("hex");
    const target = connectionAuthorizeUrl(provider, client, connectionCallbackUrl(provider, origin), state);

    const response = NextResponse.redirect(target);
    response.cookies.set(STATE_COOKIE, `${provider}:${state}`, {
        httpOnly: true,
        sameSite: "lax",
        secure: origin.startsWith("https:"),
        path: "/",
        maxAge: 600
    });
    return response;
}

/** Spend the code the provider handed back and record the account it names. */
export async function finishConnectionLink(request: Request, provider: string): Promise<Response> {
    const user = await requireUser();

    const url = new URL(request.url);
    const origin = url.origin;
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const expected = readCookie(request, STATE_COOKIE);

    const done = (outcome: LinkOutcome): Response => {
        const response = NextResponse.redirect(backTo(origin, provider, outcome));
        response.cookies.delete(STATE_COOKIE);
        return response;
    };

    if (!findConnectionProvider(provider)) return done("unavailable");
    if (!code) return done("cancelled");
    if (!state || expected !== `${provider}:${state}`) return done("state_error");

    const client = await connectionOAuthClient(provider);
    if (!client) return done("unavailable");

    try {
        const authorized = await exchangeConnectionCode(provider, client, code, connectionCallbackUrl(provider, origin));
        await saveConnection(user.id, {
            provider,
            accountId: authorized.accountId,
            label: authorized.label,
            avatarUrl: authorized.avatarUrl,
            method: "oauth",
            scope: authorized.scope,
            credential: authorized.credential
        });
        return done("linked");
    } catch (caught) {
        // The two refusals somebody can actually do something about are named;
        // everything else is a provider that did not complete the authorization.
        if (caught instanceof ConnectionClaimedError) return done("taken");
        if (caught instanceof ConnectionLimitError) return done("limit");
        return done("error");
    }
}

function readCookie(request: Request, name: string): string | undefined {
    return request.headers
        .get("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`))
        ?.slice(name.length + 1);
}
