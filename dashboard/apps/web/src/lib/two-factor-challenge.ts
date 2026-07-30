/**
 * Who is waiting at the second-factor challenge.
 *
 * At that point the password has been accepted but no session exists, so nothing
 * in the request identifies the account except the challenge cookie better-auth
 * set. The screen still has to know which ways in to offer, and the alternative -
 * asking the browser to name the account - would hand an unauthenticated caller
 * an oracle for which methods any address has.
 *
 * So the cookie is read directly: its signature is checked against the same
 * secret better-auth signs it with, and the value it carries is the identifier of
 * the pending verification row, whose value is the user id. Nothing here grants
 * anything - it only decides what a screen lists - but it is verified anyway,
 * because a check that is skipped once is a check nobody remembers was optional.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";

/** better-auth's own name for the cookie, prefixed the way this app configures it. */
const COOKIE_NAME = "two_factor";

/** Both spellings: the __Secure- prefix is added when secure cookies are on, and
 *  which one is live depends on deployment configuration rather than the request. */
function cookieNames(): string[] {
    const name = `polaris.${COOKIE_NAME}`;
    return [name, `__Secure-${name}`];
}

/**
 * Strip and check the signature better-auth appended, returning the raw value.
 *
 * The cookie is stored percent-encoded, and whether it arrives that way depends
 * on which layer parsed it. Decoding is safe either way: what comes out is the
 * identifier and a base64 signature, neither of which contains a percent sign.
 */
function unsign(signed: string, secret: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(signed);
    } catch {
        return null;
    }
    const split = decoded.lastIndexOf(".");
    if (split <= 0) return null;
    const value = decoded.slice(0, split);
    const signature = Buffer.from(decoded.slice(split + 1), "base64");
    const expected = createHmac("sha256", secret).update(value).digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    return value;
}

/**
 * The account waiting on this challenge, or null when there is no valid one -
 * no cookie, a forged signature, or a challenge that has since expired or been
 * spent. Callers treat null as "offer nothing beyond the authenticator".
 */
export async function pendingTwoFactorUserId(): Promise<string | null> {
    const store = await cookies();
    const raw = cookieNames()
        .map((name) => store.get(name)?.value)
        .find((value): value is string => Boolean(value));
    if (!raw) return null;

    const identifier = unsign(raw, loadEnv().POLARIS_AUTH_SECRET);
    if (!identifier) return null;

    const verification = await prisma.verification.findFirst({
        where: { identifier, expiresAt: { gt: new Date() } },
        select: { value: true }
    });
    if (!verification) return null;

    // The row's value is the user id better-auth will sign in once the factor is
    // satisfied. Confirm it still names a live account rather than trusting it;
    // an identifier belonging to some other kind of verification carries
    // something that is not an id at all, which the lookup refuses.
    const user = await prisma.user
        .findFirst({ where: { id: verification.value, bannedAt: null }, select: { id: true } })
        .catch(() => null);
    return user?.id ?? null;
}
