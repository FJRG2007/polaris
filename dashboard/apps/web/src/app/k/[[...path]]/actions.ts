"use server";

/**
 * The password gate in front of a grant link (`/k/<token>`).
 *
 * Public: the token plus the password is the credential. Guesses are limited
 * per link and per address exactly as every other link password gate is, and
 * every answer is one of the same generic sentences, so the form cannot be
 * used to learn which links exist.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { verifyLinkPassword } from "@polaris/core/link-password";
import { getTranslations } from "@/lib/i18n/request";
import { clientIp, hashForLog } from "@/lib/request-context";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { UNLOCK_TTL_SECONDS } from "@/lib/link-guards";
import { grantLinkPassword, grantLinkUnlockCookie, signGrantLinkUnlock } from "@/lib/access/grants";

/** Attempts allowed before the gate blocks, and the window. */
const UNLOCK_LIMIT = 10;
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

export async function unlockGrantLinkAction(
    token: string,
    password: string
): Promise<{ error?: string }> {
    const words = await getTranslations("drive");
    if (typeof token !== "string" || typeof password !== "string" || password.length > 256) {
        return { error: words("errors.wrongPassword") };
    }
    const link = await grantLinkPassword(token);
    if (!link) return { error: words("errors.linkUnavailable") };

    const limitKey = `grant-link-unlock:${link.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)).ok) {
        return { error: words("errors.tooManyAttempts") };
    }
    if (!(await verifyLinkPassword(password, link.passwordHash))) {
        return { error: words("errors.wrongPassword") };
    }

    await resetRateLimit(limitKey);
    const env = loadEnv();
    (await cookies()).set(
        grantLinkUnlockCookie(link.id),
        signGrantLinkUnlock(link.id, link.passwordHash, env.POLARIS_AUTH_SECRET),
        {
            httpOnly: true,
            sameSite: "lax",
            secure: env.POLARIS_SECURE_COOKIES,
            path: "/",
            maxAge: UNLOCK_TTL_SECONDS
        }
    );
    return {};
}
