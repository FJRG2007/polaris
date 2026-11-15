"use server";

/**
 * The password gate behind a public analytics link. Rate limited per link and
 * per address, answered in the same words whatever the reason, and reset only
 * by a correct password.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { getTranslations } from "@/lib/i18n/request";
import { clientIp, hashForLog } from "@/lib/request-context";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import * as share from "@/lib/analytics-share";

const UNLOCK_LIMIT = 8;
const UNLOCK_WINDOW_MS = 10 * 60_000;

export async function unlockAnalyticsShareAction(token: string, password: string): Promise<{ error?: string }> {
    const t = await getTranslations("publicPages");
    if (typeof token !== "string" || typeof password !== "string" || password.length > 200) {
        return { error: t("analytics.wrongPassword") };
    }
    const link = await share.resolveShareLink(token);
    if (!link || !share.shareLinkUsability(link).ok) return { error: t("denied.unavailable") };

    const limitKey = `analytics-unlock:${link.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)).ok) {
        return { error: t("analytics.tooManyAttempts") };
    }
    if (!(await share.verifySharePassword(link, password))) return { error: t("analytics.wrongPassword") };

    await resetRateLimit(limitKey);
    const env = loadEnv();
    (await cookies()).set(
        share.shareUnlockCookie(link.id),
        share.signShareUnlock(link.id, link.passwordHash, env.POLARIS_AUTH_SECRET),
        { httpOnly: true, sameSite: "lax", secure: env.POLARIS_SECURE_COOKIES, path: "/", maxAge: 60 * 60 * 12 }
    );
    return {};
}
