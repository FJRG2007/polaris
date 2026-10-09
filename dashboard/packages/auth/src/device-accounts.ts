/**
 * Several accounts signed in on one browser, and switching between them.
 *
 * Built on better-auth's multi-session plugin rather than beside it. The plugin
 * keeps one extra signed cookie per session the browser holds, adds one for
 * every session a sign-in creates, and moves the ordinary session cookie between
 * them - so the active account is still the one session cookie every other part
 * of Polaris reads, and everything that guards a session (the session guard,
 * approval, lockdown, binding, the second-factor challenge, sign-in records)
 * keeps applying to whichever account is active, unchanged.
 *
 * Three things Polaris adds around it:
 *
 * - **Sealed from HTTP.** The plugin's own endpoints answer the browser with
 *   every session token it holds. Polaris never needs that in a page: the list,
 *   the switch and the sign-out are server actions that read the cookies on the
 *   way in and hand back only names and opaque ids. So the endpoints refuse a
 *   request off the wire, the way the QR flow's do.
 * - **Enrolment of the session already open.** A session opened before this
 *   existed has no extra cookie, and the next sign-in would replace it without a
 *   trace. `enrollDeviceAccount` writes that cookie for the active session, with
 *   better-auth's own signing, before another account is added.
 * - **Signing out one account.** The plugin's sign-out ends every account on the
 *   browser. Ending one goes through its revoke endpoint instead, which hands the
 *   browser to the next account still signed in.
 */

import type { Auth } from "./auth.js";
import { multiSession } from "better-auth/plugins";
import { parseCookies } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { readIssuedCookies, type IssuedCookie } from "./device-login.js";
import {
    APIError,
    createAuthEndpoint,
    createAuthMiddleware,
    sessionMiddleware
} from "better-auth/api";

/** How many accounts one browser may hold at once. The same ceiling Discord
 *  draws, and the one the plugin enforces when a sign-in adds another. */
export const MAX_DEVICE_ACCOUNTS = 5;

/** Where the active session is given its own extra cookie. */
export const ENROLL_DEVICE_ACCOUNT_PATH = "/polaris/device-accounts/enroll";

/** Every path that hands out or moves a session token, all Polaris-internal. */
const SEALED_PATHS: ReadonlySet<string> = new Set([
    "/multi-session/list-device-sessions",
    "/multi-session/set-active",
    "/multi-session/revoke",
    ENROLL_DEVICE_ACCOUNT_PATH
]);

/** What marks a cookie as one of the plugin's: `<session cookie>_multi-<token>`. */
const MULTI_MARKER = "_multi-";

/**
 * The multi-session plugin with its endpoints sealed off from the network, plus
 * the enrolment endpoint.
 */
export function deviceAccountsPlugin(): BetterAuthPlugin {
    const plugin = multiSession({ maximumSessions: MAX_DEVICE_ACCOUNTS }) as BetterAuthPlugin;
    return {
        ...plugin,
        hooks: {
            ...plugin.hooks,
            before: [
                ...(plugin.hooks?.before ?? []),
                {
                    matcher: (context) => SEALED_PATHS.has(context.path ?? ""),
                    handler: createAuthMiddleware(async (ctx) => {
                        if (!ctx.request) return;
                        throw new APIError("NOT_FOUND", { message: "Not found" });
                    })
                }
            ]
        },
        endpoints: {
            ...plugin.endpoints,
            polarisEnrollDeviceAccount: createAuthEndpoint(
                ENROLL_DEVICE_ACCOUNT_PATH,
                { method: "POST", requireHeaders: true, use: [sessionMiddleware] },
                async (ctx) => {
                    // Checked here as well as in the hook, so the seal survives the
                    // hook being dropped.
                    if (ctx.request) throw new APIError("NOT_FOUND", { message: "Not found" });
                    const token = ctx.context.session.session.token;
                    const cookie = ctx.context.authCookies.sessionToken;
                    await ctx.setSignedCookie(
                        `${cookie.name}${MULTI_MARKER}${token.toLowerCase()}`,
                        token,
                        ctx.context.secret,
                        cookie.attributes
                    );
                    return ctx.json({ enrolled: true });
                }
            )
        }
    };
}

/** One account this browser is signed in to. The token never leaves the server:
 *  callers hand `sessionId` to the page and look the token up again here. */
export interface DeviceAccount {
    readonly sessionId: string;
    readonly token: string;
    readonly userId: string;
    readonly name: string;
    readonly email: string;
    readonly image: string | null;
    /** Whether this is the account the browser is acting as right now. */
    readonly active: boolean;
}

interface ListedSession {
    session: { id: string; token: string };
    user: { id: string; name: string; email: string; image?: string | null };
}

/** The plugin's server API, which this package cannot name through `Auth`'s
 *  inferred type (see buildPlugins). */
interface DeviceAccountsApi {
    listDeviceSessions(input: { headers: Headers }): Promise<ListedSession[]>;
    setActiveSession(input: {
        headers: Headers;
        body: { sessionToken: string };
        returnHeaders: true;
    }): Promise<{ headers: Headers }>;
    revokeDeviceSession(input: {
        headers: Headers;
        body: { sessionToken: string };
        returnHeaders: true;
    }): Promise<{ headers: Headers }>;
    polarisEnrollDeviceAccount(input: {
        headers: Headers;
        returnHeaders: true;
    }): Promise<{ headers: Headers }>;
    signOut(input: { headers: Headers; returnHeaders: true }): Promise<{ headers: Headers }>;
}

function api(auth: Auth): DeviceAccountsApi {
    return auth.api as unknown as DeviceAccountsApi;
}

/** The session the browser is acting as, read without renewing it. */
async function activeSession(auth: Auth, headers: Headers): Promise<ListedSession | null> {
    try {
        const found = await auth.api.getSession({ headers, query: { disableRefresh: true } });
        return found ? (found as unknown as ListedSession) : null;
    } catch {
        return null;
    }
}

function toAccount(entry: ListedSession, active: boolean): DeviceAccount {
    return {
        sessionId: entry.session.id,
        token: entry.session.token,
        userId: entry.user.id,
        name: entry.user.name,
        email: entry.user.email,
        image: entry.user.image ?? null,
        active
    };
}

/**
 * The accounts whose sessions this browser actually holds, the active one first.
 *
 * Only a cookie better-auth signed can name a session here, so no account ever
 * appears because somebody typed its id. The active session is included even
 * before it has its own extra cookie, since it is the one the browser is using.
 */
export async function listDeviceAccounts(auth: Auth, headers: Headers): Promise<DeviceAccount[]> {
    const [current, listed] = await Promise.all([
        activeSession(auth, headers),
        // Not swallowed: an empty answer here reads as "every other account is
        // gone", and the caller would clear the cookies that hold them.
        api(auth).listDeviceSessions({ headers })
    ]);
    const others = listed
        .filter((entry) => entry.user.id !== current?.user.id)
        .map((entry) => toAccount(entry, false))
        .sort((left, right) => left.name.localeCompare(right.name));
    return current ? [toAccount(current, true), ...others] : others;
}

/** How many more accounts this browser can take. */
export function deviceAccountRoom(count: number): number {
    return Math.max(0, MAX_DEVICE_ACCOUNTS - count);
}

/**
 * The plugin's cookies that name no live session - ended from another device,
 * expired, or replaced - so they can be cleared. They still count against the
 * plugin's ceiling when a sign-in adds an account, and a browser full of dead
 * ones would refuse to remember the next account it signs in to.
 */
export function staleDeviceCookies(
    cookieHeader: string | null,
    liveTokens: readonly string[]
): string[] {
    if (!cookieHeader) return [];
    const live = new Set(liveTokens.map((token) => token.toLowerCase()));
    const stale: string[] = [];
    for (const name of parseCookies(cookieHeader).keys()) {
        const at = name.indexOf(MULTI_MARKER);
        if (at < 0) continue;
        if (!live.has(name.slice(at + MULTI_MARKER.length).toLowerCase())) stale.push(name);
    }
    return stale;
}

/** The request's cookies with the ones a previous call just issued laid over
 *  them, so a second call in the same action sees what the browser will. */
function withIssued(headers: Headers, issued: readonly IssuedCookie[]): Headers {
    const jar = parseCookies(headers.get("cookie") ?? "");
    for (const cookie of issued) {
        if (cookie.options.maxAge === 0) jar.delete(cookie.name);
        else jar.set(cookie.name, cookie.value);
    }
    const next = new Headers(headers);
    next.set("cookie", Array.from(jar, ([name, value]) => `${name}=${value}`).join("; "));
    return next;
}

/** Give the active session its own extra cookie, so adding another account
 *  cannot push it out. Empty when there is no active session. */
export async function enrollDeviceAccount(auth: Auth, headers: Headers): Promise<IssuedCookie[]> {
    try {
        const { headers: issued } = await api(auth).polarisEnrollDeviceAccount({
            headers,
            returnHeaders: true
        });
        return readIssuedCookies(issued);
    } catch {
        return [];
    }
}

/**
 * Make another account this browser holds the active one. Null when the id names
 * no account on this browser - including one it lost since the list was drawn -
 * or names the account already active.
 */
export async function switchDeviceAccount(
    auth: Auth,
    headers: Headers,
    sessionId: string
): Promise<{ account: DeviceAccount; cookies: IssuedCookie[] } | null> {
    const account = (await listDeviceAccounts(auth, headers)).find(
        (entry) => entry.sessionId === sessionId
    );
    if (!account || account.active) return null;
    try {
        const { headers: issued } = await api(auth).setActiveSession({
            headers,
            body: { sessionToken: account.token },
            returnHeaders: true
        });
        return { account, cookies: readIssuedCookies(issued) };
    } catch {
        return null;
    }
}

/**
 * Sign one account on this browser out, leaving the others signed in. Ending
 * the active one hands the browser to the next account it holds, or to nobody.
 * Null when the id names no account on this browser.
 */
export async function signOutDeviceAccount(
    auth: Auth,
    headers: Headers,
    sessionId: string
): Promise<{ account: DeviceAccount; cookies: IssuedCookie[] } | null> {
    const account = (await listDeviceAccounts(auth, headers)).find(
        (entry) => entry.sessionId === sessionId
    );
    if (!account) return null;
    // The plugin can only revoke a session it has a cookie for, and the active
    // one may predate it. Enrolled first, and the revoke shown that cookie.
    const enrolled = account.active ? await enrollDeviceAccount(auth, headers) : [];
    try {
        const { headers: issued } = await api(auth).revokeDeviceSession({
            headers: withIssued(headers, enrolled),
            body: { sessionToken: account.token },
            returnHeaders: true
        });
        return { account, cookies: [...enrolled, ...readIssuedCookies(issued)] };
    } catch {
        return null;
    }
}

/** Sign every account on this browser out. */
export async function signOutAllDeviceAccounts(
    auth: Auth,
    headers: Headers
): Promise<{ accounts: DeviceAccount[]; cookies: IssuedCookie[] }> {
    const accounts = await listDeviceAccounts(auth, headers);
    try {
        const { headers: issued } = await api(auth).signOut({ headers, returnHeaders: true });
        return { accounts, cookies: readIssuedCookies(issued) };
    } catch {
        return { accounts, cookies: [] };
    }
}
