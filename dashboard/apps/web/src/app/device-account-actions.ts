"use server";

/**
 * The accounts signed in on this browser: listing them, switching between them,
 * adding one, and signing them out one at a time or all together.
 *
 * None of these run the session guard first, on purpose. They have to work from
 * the screens the guard sends people to - a sign-in held for approval, a locked
 * session, the sign-in page itself - because "switch back to my other account" is
 * exactly what somebody stuck on one of those wants. They cannot widen anything:
 * every account they touch is one this browser already holds a signed cookie for,
 * and the account a switch lands on is guarded on its very next request like any
 * other session.
 *
 * Session tokens never reach the page. It is handed the session's id and the
 * account's name, and the token is looked up again here from the cookies.
 */

import { z } from "zod";
import { auth } from "@/lib/auth";
import { cookies, headers } from "next/headers";
import { clientIp } from "@/lib/request-context";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { getTranslations } from "@/lib/i18n/request";
import { noteSignedOut } from "@/lib/session-sign-out";
import {
    deviceAccountRoom,
    enrollDeviceAccount,
    listDeviceAccounts,
    signOutAllDeviceAccounts,
    signOutDeviceAccount,
    staleDeviceCookies,
    switchDeviceAccount,
    type DeviceAccount,
    type IssuedCookie
} from "@polaris/auth";

/** One account on this browser, as a page may see it. */
export interface DeviceAccountView {
    /** The session's id: what the page hands back to switch or sign out. */
    readonly id: string;
    readonly userId: string;
    readonly name: string;
    readonly email: string;
    readonly image: string | null;
    readonly active: boolean;
}

export interface DeviceAccounts {
    readonly accounts: DeviceAccountView[];
    /** How many more this browser can take. */
    readonly room: number;
}

const sessionIdSchema = z.string().uuid();

/** Switching is cheap and harmless, but not something to do hundreds of times a
 *  minute; the ceiling is far above anybody pressing it by hand. */
const SWITCH_LIMIT = 30;
const SWITCH_WINDOW_MS = 60 * 1000;

function view(account: DeviceAccount): DeviceAccountView {
    return {
        id: account.sessionId,
        userId: account.userId,
        name: account.name,
        email: account.email,
        image: account.image,
        active: account.active
    };
}

async function requestHeaders(): Promise<Headers> {
    return new Headers(await headers());
}

async function apply(issued: readonly IssuedCookie[]): Promise<void> {
    const store = await cookies();
    for (const cookie of issued) store.set(cookie.name, cookie.value, cookie.options);
}

/** Clear the browser's cookies for sessions that no longer exist. */
async function dropStale(request: Headers, accounts: readonly DeviceAccount[]): Promise<void> {
    const stale = staleDeviceCookies(
        request.get("cookie"),
        accounts.map((account) => account.token)
    );
    if (stale.length > 0) await expire(stale);
}

async function expire(names: readonly string[]): Promise<void> {
    const store = await cookies();
    for (const name of names) {
        store.set(name, "", { path: "/", maxAge: 0, secure: name.startsWith("__Secure-"), httpOnly: true });
    }
}

async function failure(): Promise<{ error: string }> {
    return { error: (await getTranslations("nav"))("account.switcher.failed") };
}

/** The accounts this browser is signed in to, the active one first. */
export async function deviceAccountsAction(): Promise<DeviceAccounts> {
    const request = await requestHeaders();
    const accounts = await listDeviceAccounts(auth, request);
    await dropStale(request, accounts);
    return { accounts: accounts.map(view), room: deviceAccountRoom(accounts.length) };
}

/** Act as another account this browser holds. */
export async function switchAccountAction(sessionId: unknown): Promise<{ error?: string }> {
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) return failure();
    const throttle = await rateLimit(`account-switch:${(await clientIp()) ?? "unknown"}`, SWITCH_LIMIT, SWITCH_WINDOW_MS);
    if (!throttle.ok) return { error: (await getTranslations("nav"))("account.switcher.tooFast") };
    const switched = await switchDeviceAccount(auth, await requestHeaders(), parsed.data);
    if (!switched) return failure();
    await apply(switched.cookies);
    await recordAudit({
        actorId: switched.account.userId,
        action: "account.session.switched-to",
        targetType: "session",
        targetId: switched.account.sessionId,
        sessionId: switched.account.sessionId
    });
    return {};
}

/**
 * Get the browser ready to sign in to one more account: the active session is
 * given its own cookie so the sign-in cannot replace it, and the ceiling is
 * checked. Refused once the browser holds as many accounts as it may.
 */
export async function prepareAddAccountAction(): Promise<{ error?: string }> {
    const request = await requestHeaders();
    const accounts = await listDeviceAccounts(auth, request);
    await dropStale(request, accounts);
    if (deviceAccountRoom(accounts.length) === 0) {
        return { error: (await getTranslations("nav"))("account.switcher.full") };
    }
    await apply(await enrollDeviceAccount(auth, request));
    return {};
}

/**
 * Sign one account on this browser out, leaving the others signed in. Without
 * an id, the account the browser is acting as - which hands the browser to the
 * next account it holds, if there is one.
 *
 * The active session may already be gone (ended from another device, or along
 * with the rest of this device's from the sessions page). Then there is nothing
 * to end, only a cookie to clear and the next account to hand over to.
 */
export async function signOutAccountAction(sessionId: unknown = null): Promise<{ error?: string }> {
    const parsed = sessionIdSchema.nullable().safeParse(sessionId);
    if (!parsed.success) return failure();
    const request = await requestHeaders();
    const accounts = await listDeviceAccounts(auth, request);
    const target = parsed.data
        ? accounts.find((account) => account.sessionId === parsed.data)
        : accounts.find((account) => account.active);

    if (!target) {
        if (parsed.data) return failure();
        const next = accounts[0];
        const handed = next ? await switchDeviceAccount(auth, request, next.sessionId) : null;
        if (handed) await apply(handed.cookies);
        else await expire([(await auth.$context).authCookies.sessionToken.name]);
        return {};
    }

    await noteSignedOut(target.userId, target.sessionId).catch(() => undefined);
    const ended = await signOutDeviceAccount(auth, request, target.sessionId);
    if (!ended) return failure();
    await apply(ended.cookies);
    return {};
}

/** Sign every account on this browser out. */
export async function signOutAllAccountsAction(): Promise<void> {
    const ended = await signOutAllDeviceAccounts(auth, await requestHeaders());
    await apply(ended.cookies);
    for (const account of ended.accounts) {
        await noteSignedOut(account.userId, account.sessionId).catch(() => undefined);
    }
}
