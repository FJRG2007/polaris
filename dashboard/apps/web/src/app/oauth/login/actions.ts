"use server";

/**
 * What the sign-in screen needs before anybody has proved who they are: resolving
 * an identifier to the account email so the client can finish through better-auth's
 * email flow, the two hints that decide which alternatives are worth offering, and
 * the QR code a device that is already signed in can answer.
 *
 * Nothing here confirms whether an account exists: an identifier that matches
 * nothing returns null and the caller shows the same generic error either way.
 */

import { prisma } from "@polaris/db";
import { headers } from "next/headers";
import { loadEnv } from "@polaris/config";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { rateLimit } from "@/lib/rate-limit-service";
import { passkeyRelyingPartyId } from "@polaris/core";
import {
    openSignInCode,
    redeemSignInCode,
    type QrSignInCode,
    type QrSignInStatus
} from "@/lib/qr-sign-in-service";

/** Caps how fast one address can be probed for a passkey. Generous enough for a
 *  person retyping their email, useless for enumerating a list. */
const PASSKEY_HINT_LIMIT = 10;
const PASSKEY_HINT_WINDOW_MS = 10 * 60 * 1000;

export async function resolveIdentifier(identifier: string): Promise<string | null> {
    const value = identifier.trim().toLowerCase();
    if (value.includes("@")) return value;
    const user = await prisma.user.findUnique({ where: { username: value }, select: { email: true } });
    return user?.email ?? null;
}

/**
 * Whether this deployment can email a sign-in link. Says nothing about any
 * account - it is the instance's mail configuration, which the sign-in page needs
 * in order to decide whether offering the option would be a dead end.
 */
export async function magicLinkAvailable(): Promise<boolean> {
    return (await getAuthMailStatus()).channelId !== null;
}

/**
 * Whether the account behind an identifier has a passkey, so the sign-in page can
 * offer it without the user having to know they set one up.
 *
 * This does answer a question about a specific account, which makes it an oracle:
 * an unauthenticated caller learns that an address both exists and has a passkey.
 * It is offered anyway because the alternative - a passkey button that is always
 * present and usually fails - trains people to ignore it, and because the same
 * fact is observable from the WebAuthn ceremony itself. It is throttled per
 * address so it cannot be swept, and it never distinguishes "no account" from
 * "no passkey".
 *
 * Only passkeys bound to the address the page is open on count: WebAuthn will
 * not offer any other, so a button here for one registered elsewhere would raise
 * a prompt that finds nothing.
 */
export async function accountHasPasskey(identifier: string): Promise<boolean> {
    const value = identifier.trim().toLowerCase();
    if (!value) return false;
    const rpId = await currentRelyingPartyId();
    if (!rpId) return false;
    const throttle = await rateLimit(`passkey-hint:${value}`, PASSKEY_HINT_LIMIT, PASSKEY_HINT_WINDOW_MS);
    if (!throttle.ok) return false;
    const email = await resolveIdentifier(value);
    if (!email) return false;
    const count = await prisma.passkey.count({
        where: { user: { email }, OR: boundHere(rpId) }
    });
    return count > 0;
}

/** The address this request came in on, or null when it could not hold a passkey.
 *  Unverified on purpose: it only decides whether to offer a button to the caller
 *  about their own browser, and a forged header buys nothing but a useless one. */
async function currentRelyingPartyId(): Promise<string | null> {
    const store = await headers();
    return passkeyRelyingPartyId(store.get("x-forwarded-host") ?? store.get("host"));
}

/**
 * Open a code for the QR on the sign-in screen. Unauthenticated by nature -
 * nobody has said who they are yet - so it is throttled per address and the code
 * it hands back is useless until somebody already signed in allows it.
 */
export async function startQrSignIn(): Promise<{ code?: QrSignInCode; error?: string }> {
    return openSignInCode();
}

/**
 * Ask whether the code has been answered. Comes back "approved" only once the
 * session cookies are on this response, so the caller navigates straight into the
 * dashboard rather than reloading its way there.
 */
export async function pollQrSignIn(deviceCode: unknown): Promise<QrSignInStatus> {
    if (typeof deviceCode !== "string" || deviceCode.length === 0) return "expired";
    return redeemSignInCode(deviceCode);
}

/** Matches the passkeys that sign in on an address, including the ones registered
 *  before passkeys followed the address - those were all issued under the app URL. */
function boundHere(rpId: string): { rpId: string | null }[] {
    const published = passkeyRelyingPartyId(loadEnv().POLARIS_APP_URL);
    return rpId === published ? [{ rpId }, { rpId: null }] : [{ rpId }];
}
