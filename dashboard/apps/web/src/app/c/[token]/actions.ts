"use server";

/**
 * The one thing a visitor to a shared Polar chat can do: type its password.
 *
 * Answers the same way for a token that names nothing and one that no longer
 * opens, so the form cannot be used to find out which tokens are real.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import * as gate from "@/lib/polar/share-access";
import { getTranslations } from "@/lib/i18n/request";
import { UNLOCK_TTL_SECONDS } from "@/lib/link-guards";
import { clientIp, hashForLog } from "@/lib/request-context";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";

/** Guesses allowed per link per address per window. */
const UNLOCK_LIMIT = 8;
const UNLOCK_WINDOW_MS = 10 * 60_000;

export async function unlockPolarShareAction(
    token: string,
    password: string
): Promise<{ error?: string }> {
    const t = await getTranslations("publicPages");
    const share = await gate.polarShareForUnlock(token);
    if (!share) return { error: t("denied.unavailable") };
    if (!password || password.length > 256) return { error: t("polarShare.typePassword") };

    const limitKey = `polar-unlock:${share.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)).ok) {
        return { error: t("polarShare.tooMany") };
    }
    if (!(await gate.polarSharePasswordMatches(share, password))) {
        return { error: t("polarShare.wrongPassword") };
    }

    await resetRateLimit(limitKey);
    (await cookies()).set(
        gate.polarUnlockCookie(share.id),
        gate.signPolarUnlock(share.id, share.passwordHash),
        {
            httpOnly: true,
            sameSite: "lax",
            secure: loadEnv().POLARIS_SECURE_COOKIES,
            path: "/",
            maxAge: UNLOCK_TTL_SECONDS
        }
    );
    return {};
}
