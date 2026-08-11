/**
 * Both halves of a round trip to a provider, for the two things one can end in:
 * linking an outside account to this one, and signing in with an account that is
 * already linked.
 *
 * A random state is stored in an httpOnly cookie and echoed back, so neither can
 * be started on somebody else's behalf: without it, sending somebody a callback
 * URL would put the sender's account on their profile. The provider and what the
 * trip is for travel in the same cookie, so a code minted for one service can
 * never be spent as another, and a code minted to link an account can never be
 * spent to open a session.
 *
 * The callback path is fixed per provider - it is registered on the operator's
 * own application, and an application cannot learn a new one without somebody
 * editing it - which is why one callback serves both and reads the cookie to
 * find out which it is.
 *
 * So is the address underneath it. Every URL here comes from `connectionFlowOrigin`
 * rather than from the request, because the request arrives from the proxy on the
 * socket the server binds and a redirect URI built from that is one no provider
 * accepts - and because the whole round trip has to happen on one host: the state
 * cookie set at the start only exists on the host the provider returns to.
 *
 * Every outcome ends on the screen the person started from, with a flag saying
 * what happened, rather than on a bare error page.
 */

import { auth } from "@/lib/auth";
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { markConnectionProven } from "./proven";
import { clientIp } from "@/lib/request-context";
import { rateLimit } from "@/lib/rate-limit-service";
import { requestOrigin } from "@/lib/domain-service";
import { findConnectionProvider } from "@polaris/core";
import { signInWithConnection, type ConnectionSignInResult } from "@polaris/auth";
import { readSteamPersona, steamAuthorizeUrl, STEAM_PROVIDER, verifySteamReturn } from "./steam";
import { ConnectionClaimedError, ConnectionLimitError, saveConnection, signInConnection } from "./store";
import {
    connectionAuthorizeUrl,
    connectionCallbackUrl,
    connectionFlowOrigin,
    connectionIdentity,
    connectionLinkAvailable,
    connectionOAuthClient,
    connectionSignInOffered,
    exchangeConnectionCode
} from "./oauth";

const STATE_COOKIE = "polaris_connection_state";
const CONNECTIONS_SCREEN = "/account/connections";
const LOGIN_SCREEN = "/oauth/login";
const CHALLENGE_SCREEN = "/oauth/2fa";
/** Where a finished sign-in lands when the screen asked for nothing else. The
 *  same default the sign-in form uses. */
const DEFAULT_TARGET = "/drive";

/** How long the round trip may take. Longer than any consent screen needs, short
 *  enough that an abandoned one is not left standing. */
const STATE_TTL_SECONDS = 600;

/** Sign-in attempts one address may start in the window. The round trip is
 *  cheap for the caller and costs this deployment a request to the provider, so
 *  it is capped before anything else happens. */
const SIGN_IN_LIMIT = 10;
const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;

/** What the round trip was started for. */
/** `storage` is a link that also asks for access to the files Polaris creates.
 *  Everything downstream treats it as a link; only the consent screen differs. */
type ConnectionMode = "link" | "signin" | "storage";

/** What the round trip came back with, as the screen reads it. */
export type LinkOutcome = "linked" | "cancelled" | "state_error" | "taken" | "limit" | "unavailable" | "error";

/**
 * What a sign-in came back with.
 *
 * `refused` covers every way an account can fail to be a way in here - not
 * linked to anybody, linked but not allowed to sign in by its owner, or refused
 * by the operator - deliberately as one answer. Telling them apart would tell
 * whoever holds a Google account whether it is linked on this deployment, which
 * is nobody's business but its owner's.
 */
export type SignInOutcome = "cancelled" | "state_error" | "refused" | "unavailable" | "error";

/** The state cookie's payload: which service, what for, the value to echo back,
 *  and where the person was headed. */
interface FlowState {
    provider: string;
    mode: ConnectionMode;
    state: string;
    target?: string;
}

function backToConnections(origin: string, provider: string, outcome: LinkOutcome): URL {
    const url = new URL(CONNECTIONS_SCREEN, origin);
    url.searchParams.set("provider", provider);
    url.searchParams.set("connection", outcome);
    return url;
}

function backToLogin(origin: string, provider: string, outcome: SignInOutcome): URL {
    const url = new URL(LOGIN_SCREEN, origin);
    url.searchParams.set("provider", provider);
    url.searchParams.set("signin", outcome);
    return url;
}

/**
 * Where a finished sign-in goes, as the screen asked for it.
 *
 * Only ever a same-origin relative path: the parameter is the caller's to write,
 * and following it anywhere else would make this an open redirect.
 */
function safeTarget(value: string | null): string | undefined {
    if (!value || !value.startsWith("/") || value.startsWith("//")) return undefined;
    return value;
}

/**
 * Send somebody to the provider's own screen, remembering what for.
 *
 * Without the operator's application there is nowhere to send them, so the trip
 * ends before it starts - on the screen it was started from, which is the only
 * one that can explain what is missing.
 */
async function begin(
    request: Request,
    provider: string,
    mode: ConnectionMode,
    target?: string
): Promise<Response> {
    const origin = await connectionFlowOrigin();
    const moved = moveOnto(request, origin);
    if (moved) return moved;
    // Steam has no application to look up: it proves an account over OpenID, so
    // the trip can start on an instance where nothing has been connected.
    if (provider === STEAM_PROVIDER) return beginSteam(origin, mode, target);
    const client = await connectionOAuthClient(provider);
    if (!client) {
        return mode === "signin"
            ? endSignIn(origin, provider, "unavailable")
            : endLink(origin, provider, "unavailable");
    }

    const state = randomBytes(16).toString("hex");
    const payload: FlowState = { provider, mode, state, ...(target ? { target } : {}) };
    const authorize = connectionAuthorizeUrl(
        provider,
        client,
        connectionCallbackUrl(provider, origin),
        state,
        mode
    );

    const response = NextResponse.redirect(authorize);
    response.cookies.set(STATE_COOKIE, JSON.stringify(payload), {
        httpOnly: true,
        sameSite: "lax",
        secure: origin.startsWith("https:"),
        path: "/",
        maxAge: STATE_TTL_SECONDS
    });
    return response;
}

/** Marks the pass that has already been moved, so it happens at most once. */
const MOVED = "moved";

/**
 * Start the trip over on the address it has to finish on, when the browser is
 * somewhere else.
 *
 * Somebody can reach this dashboard by several names - polaris.local on the LAN,
 * its domain from outside - but the provider returns to exactly one, the one
 * registered on the operator's application. The state cookie set a few lines
 * below, and the session that authorized this, belong to whichever host the
 * browser is on, so the trip has to move before either is written rather than
 * after, or the callback arrives with neither.
 *
 * The marker is what stops a second move: this route sees the proxy's internal
 * address however it was reached, so an address it could not compare would send
 * it round again.
 */
function moveOnto(request: Request, origin: string): Response | null {
    const requested = new URL(request.url);
    if (requestOrigin(request) === origin || requested.searchParams.get(MOVED) === "1") return null;
    const target = new URL(requested.pathname, origin);
    for (const [key, value] of requested.searchParams) target.searchParams.set(key, value);
    target.searchParams.set(MOVED, "1");
    return NextResponse.redirect(target);
}

/**
 * The same trip for Steam, whose assertion comes back in the URL rather than as a
 * code to spend.
 *
 * The state rides in `return_to` because that is a parameter Steam signs and
 * returns unchanged, so it comes back beside the assertion and can be matched
 * against the cookie exactly as every other provider's is.
 */
function beginSteam(origin: string, mode: ConnectionMode, target?: string): Response {
    const state = randomBytes(16).toString("hex");
    const payload: FlowState = { provider: STEAM_PROVIDER, mode, state, ...(target ? { target } : {}) };
    const returnTo = new URL(connectionCallbackUrl(STEAM_PROVIDER, origin));
    returnTo.searchParams.set("state", state);

    const response = NextResponse.redirect(steamAuthorizeUrl(returnTo.toString(), `${origin}/`));
    response.cookies.set(STATE_COOKIE, JSON.stringify(payload), {
        httpOnly: true,
        sameSite: "lax",
        secure: origin.startsWith("https:"),
        path: "/",
        maxAge: STATE_TTL_SECONDS
    });
    return response;
}

/**
 * Send somebody to the provider's own authorization screen, and nowhere else.
 *
 * `?scope=storage` asks for the extra permission a backup destination needs -
 * lasting access to the files Polaris creates. It is a separate request rather
 * than part of the ordinary link so that somebody connecting Google to see their
 * calendar is never shown a consent screen asking to reach their files.
 */
export async function startConnectionLink(request: Request, provider: string): Promise<Response> {
    const user = await requireUser();
    const url = new URL(request.url);
    // Refused here and not only on the card that offers it: the card is a link, and
    // a link is something anybody can type. Administrators pass while the service is
    // unproven because somebody has to be the first one through it.
    if (!findConnectionProvider(provider) || !(await connectionLinkAvailable(provider, { admin: user.isAdmin }))) {
        return NextResponse.redirect(backToConnections(await connectionFlowOrigin(), provider, "unavailable"));
    }
    return begin(request, provider, url.searchParams.get("scope") === "storage" ? "storage" : "link");
}

/**
 * Start signing in with a linked account.
 *
 * Deliberately open to anybody signed out - that is the whole point - so what
 * stands in for a session is the operator's switch and a limit per address. It
 * says nothing about any account: an unknown provider and one the operator has
 * closed come back the same way.
 */
export async function startConnectionSignIn(request: Request, provider: string): Promise<Response> {
    const url = new URL(request.url);
    if (!(await connectionSignInOffered(provider))) {
        return NextResponse.redirect(backToLogin(await connectionFlowOrigin(), provider, "unavailable"));
    }
    const throttle = await rateLimit(`connection-signin:${(await clientIp()) ?? "unknown"}`, SIGN_IN_LIMIT, SIGN_IN_WINDOW_MS);
    if (!throttle.ok) return NextResponse.redirect(backToLogin(await connectionFlowOrigin(), provider, "error"));

    return begin(request, provider, "signin", safeTarget(url.searchParams.get("redirect")));
}

/**
 * Spend the code the provider handed back.
 *
 * What it is spent on is decided by the cookie this deployment set when the trip
 * started, never by anything in the URL - which is what stops a code minted on
 * the connections screen from being redeemed as a sign-in.
 */
export async function finishConnectionCallback(request: Request, provider: string): Promise<Response> {
    const url = new URL(request.url);
    const origin = await connectionFlowOrigin();
    const held = readState(request);
    if (provider === STEAM_PROVIDER) return finishSteam(url, origin, held);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const valid = held?.provider === provider && held.state === state && Boolean(state);

    if (held?.mode === "signin") {
        if (!code) return endSignIn(origin, provider, "cancelled");
        if (!valid) return endSignIn(origin, provider, "state_error");
        return finishSignIn(request, origin, provider, code, held.target);
    }

    // Anything that is not a sign-in is a link, including a callback that
    // arrived with no cookie at all: it lands on the screen it was started from,
    // which for a link is the one that says what went wrong.
    if (!code) return endLink(origin, provider, "cancelled");
    if (!valid) return endLink(origin, provider, "state_error");
    return finishLink(origin, provider, code);
}

/**
 * Record the Steam account somebody came back with.
 *
 * Two things have to hold and neither is enough alone: the state has to match the
 * cookie this deployment set, so the trip was started here and by this person,
 * and Steam has to say the assertion is its own, so the id is not one somebody
 * typed into the URL.
 *
 * Linking only. Signing in with Steam is not offered, and a callback that says it
 * is gets the same refusal as one with no cookie at all.
 */
async function finishSteam(url: URL, origin: string, held: FlowState | null): Promise<Response> {
    if (url.searchParams.get("openid.mode") === "cancel") return endLink(origin, STEAM_PROVIDER, "cancelled");
    const state = url.searchParams.get("state");
    if (!held || held.provider !== STEAM_PROVIDER || held.mode === "signin" || !state || held.state !== state) {
        return endLink(origin, STEAM_PROVIDER, "state_error");
    }
    const user = await requireUser();
    const steamId = await verifySteamReturn(url.searchParams).catch(() => null);
    if (!steamId) return endLink(origin, STEAM_PROVIDER, "error");

    try {
        // The name is a nicety and Steam may not be willing to give it - no key,
        // or a private profile - so a link is never held up by it.
        const persona = await readSteamPersona(steamId).catch(() => null);
        await saveConnection(user.id, {
            provider: STEAM_PROVIDER,
            accountId: steamId,
            label: persona?.name ?? steamId,
            avatarUrl: persona?.avatarUrl ?? null,
            method: "oauth",
            email: null,
            // Nothing to act with: proving who somebody is was the whole point,
            // and Polaris asks Steam for nothing else on their behalf.
            credential: null
        });
        return endLink(origin, STEAM_PROVIDER, "linked");
    } catch (caught) {
        if (caught instanceof ConnectionClaimedError) return endLink(origin, STEAM_PROVIDER, "taken");
        if (caught instanceof ConnectionLimitError) return endLink(origin, STEAM_PROVIDER, "limit");
        return endLink(origin, STEAM_PROVIDER, "error");
    }
}

/** Record the account the provider vouched for against the signed-in user. */
async function finishLink(origin: string, provider: string, code: string): Promise<Response> {
    const user = await requireUser();

    const client = await connectionOAuthClient(provider);
    if (!client) return endLink(origin, provider, "unavailable");

    try {
        const authorized = await exchangeConnectionCode(provider, client, code, connectionCallbackUrl(provider, origin));
        await saveConnection(user.id, {
            provider,
            accountId: authorized.accountId,
            label: authorized.label,
            avatarUrl: authorized.avatarUrl,
            method: "oauth",
            scope: authorized.scope,
            // Held for its owner, so nobody else can be given an account here
            // under the address the provider just vouched for.
            email: authorized.email,
            credential: authorized.credential
        });
        // The one thing that settles whether this application works, and the only
        // moment it can be observed: the provider took somebody all the way through
        // and handed back an account. From here the service is offered to everybody.
        await markConnectionProven(provider);
        return endLink(origin, provider, "linked");
    } catch (caught) {
        // The two refusals somebody can actually do something about are named;
        // everything else is a provider that did not complete the authorization.
        if (caught instanceof ConnectionClaimedError) return endLink(origin, provider, "taken");
        if (caught instanceof ConnectionLimitError) return endLink(origin, provider, "limit");
        return endLink(origin, provider, "error");
    }
}

/**
 * Open a session for whoever linked the account the provider just vouched for.
 *
 * Both switches are re-read here rather than trusted from the start of the trip:
 * a minute has passed, and the one that matters is the one in force when the
 * session is issued. The session itself is better-auth's - the challenge, the
 * record of how this sign-in proved itself, and the remembered-device pass all
 * hang off it - so an account with a second factor armed lands on the challenge
 * screen with no session, exactly as it would after a password.
 */
async function finishSignIn(
    request: Request,
    origin: string,
    provider: string,
    code: string,
    target: string | undefined
): Promise<Response> {
    if (!(await connectionSignInOffered(provider))) return endSignIn(origin, provider, "unavailable");

    const client = await connectionOAuthClient(provider);
    if (!client) return endSignIn(origin, provider, "unavailable");

    let accountId: string;
    try {
        accountId = (await connectionIdentity(provider, client, code, connectionCallbackUrl(provider, origin))).accountId;
    } catch {
        return endSignIn(origin, provider, "error");
    }

    const match = await signInConnection(provider, accountId);
    if (!match) return endSignIn(origin, provider, "refused");
    // Refused before a session exists rather than after the guard kills one, so a
    // suspended account never holds a session for even a moment.
    if (match.banned) {
        const response = NextResponse.redirect(new URL(`${LOGIN_SCREEN}?banned=1`, origin));
        response.cookies.delete(STATE_COOKIE);
        return response;
    }

    let issued: ConnectionSignInResult;
    try {
        issued = await signInWithConnection(auth, { userId: match.userId, provider }, request.headers);
    } catch {
        // The account was there a moment ago, so this is one that has just been
        // deleted, or a session better-auth could not create.
        return endSignIn(origin, provider, "error");
    }
    const response = NextResponse.redirect(
        new URL(issued.challenged ? CHALLENGE_SCREEN : target ?? DEFAULT_TARGET, origin)
    );
    for (const cookie of issued.cookies) response.cookies.set(cookie.name, cookie.value, cookie.options);
    response.cookies.delete(STATE_COOKIE);
    return response;
}

function endLink(origin: string, provider: string, outcome: LinkOutcome): Response {
    const response = NextResponse.redirect(backToConnections(origin, provider, outcome));
    response.cookies.delete(STATE_COOKIE);
    return response;
}

function endSignIn(origin: string, provider: string, outcome: SignInOutcome): Response {
    const response = NextResponse.redirect(backToLogin(origin, provider, outcome));
    response.cookies.delete(STATE_COOKIE);
    return response;
}

/** The flow this browser started, or null when there is none Polaris wrote. */
function readState(request: Request): FlowState | null {
    const raw = request.headers
        .get("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${STATE_COOKIE}=`))
        ?.slice(STATE_COOKIE.length + 1);
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(decodeURIComponent(raw));
        const held = parsed as Partial<FlowState>;
        if (typeof held?.provider !== "string" || typeof held.state !== "string") return null;
        return {
            provider: held.provider,
            mode: held.mode === "signin" ? "signin" : "link",
            state: held.state,
            target: typeof held.target === "string" ? held.target : undefined
        };
    } catch {
        return null;
    }
}
