"use server";

/**
 * The password in front of a meeting's guest link.
 *
 * Answers the same way for a token that names nothing and one that no longer
 * opens, so it cannot be used to find out which tokens are real.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { getTranslations } from "@/lib/i18n/request";
import { UNLOCK_TTL_SECONDS } from "@/lib/link-guards";
import * as gate from "@/lib/chat/meeting-link-access";
import { clientIp, hashForLog } from "@/lib/request-context";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";

/** Guesses allowed per link per address per window. */
const UNLOCK_LIMIT = 8;
const UNLOCK_WINDOW_MS = 10 * 60_000;

export async function unlockMeetingLinkAction(token: string, password: string): Promise<{ error?: string }> {
    const t = await getTranslations("publicPages");
    const meeting = await gate.meetingLinkForUnlock(String(token ?? ""));
    if (!meeting) return { error: t("denied.unavailable") };
    if (!password || password.length > 256) return { error: t("meetingLink.typePassword") };

    const limitKey = `meeting-unlock:${meeting.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)).ok) {
        return { error: t("meetingLink.tooMany") };
    }
    if (!(await gate.meetingLinkPasswordMatches(meeting, password))) {
        return { error: t("meetingLink.wrongPassword") };
    }

    await resetRateLimit(limitKey);
    (await cookies()).set(gate.meetingUnlockCookie(meeting.id), gate.signMeetingUnlock(meeting.id, meeting.passwordHash), {
        httpOnly: true,
        sameSite: "lax",
        secure: loadEnv().POLARIS_SECURE_COOKIES,
        path: "/",
        maxAge: UNLOCK_TTL_SECONDS
    });
    return {};
}
