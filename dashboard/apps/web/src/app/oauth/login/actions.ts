"use server";

/**
 * Resolve a sign-in identifier (email or username) to the account email, so the
 * client can complete sign-in through better-auth's email flow. Returns null when
 * no account matches; the caller shows a generic error either way, so this never
 * confirms whether a given username exists.
 */

import { prisma } from "@polaris/db";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { rateLimit } from "@/lib/rate-limit-service";

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
 */
export async function accountHasPasskey(identifier: string): Promise<boolean> {
    const value = identifier.trim().toLowerCase();
    if (!value) return false;
    const throttle = await rateLimit(`passkey-hint:${value}`, PASSKEY_HINT_LIMIT, PASSKEY_HINT_WINDOW_MS);
    if (!throttle.ok) return false;
    const email = await resolveIdentifier(value);
    if (!email) return false;
    const count = await prisma.passkey.count({ where: { user: { email } } });
    return count > 0;
}
