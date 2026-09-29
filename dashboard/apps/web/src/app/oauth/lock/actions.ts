"use server";

/**
 * Unlocking a dashboard the inactivity timer closed. These actions deliberately
 * do NOT go through requireUser: it redirects a locked session straight back
 * here, so the one screen that exists to clear the lock has to resolve the
 * session itself.
 *
 * The PIN is four to six digits, which is guessable in a way a password is not,
 * so every attempt is counted per session and the window closes hard once the
 * budget is spent. A wrong PIN and a wrong password are reported identically.
 */

import { verifyAccountPassword, verifyQuickPin } from "@polaris/auth";
import { prisma } from "@polaris/db";
import { auth } from "@/lib/auth";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { resolveSession } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";

/** Attempts allowed per locked session before it must be signed in again. */
const UNLOCK_LIMIT = 5;
const UNLOCK_WINDOW_MS = 10 * 60 * 1000;

export async function unlockSessionAction(secret: string, method: "pin" | "password"): Promise<{ error?: string }> {
    const t = await getTranslations("auth");
    const session = await resolveSession();
    if (!session) return { error: t("lock.errors.ended") };

    const key = `session-unlock:${session.sessionId}`;
    const throttle = await rateLimit(key, UNLOCK_LIMIT, UNLOCK_WINDOW_MS);
    if (!throttle.ok) {
        return { error: t("lock.errors.tooMany", { minutes: Math.ceil(throttle.retryAfterMs / 60000) }) };
    }

    const value = String(secret);
    const unlocked =
        method === "pin"
            ? await verifyQuickPin(auth, session.id, value)
            : await verifyAccountPassword(auth, session.id, value);
    if (!unlocked) {
        await recordAudit({
            actorId: session.id,
            action: "account.unlock.failed",
            targetType: "session",
            targetId: session.sessionId,
            metadata: { method }
        });
        return { error: method === "pin" ? t("lock.errors.wrongPin") : t("lock.errors.wrongPassword") };
    }

    await prisma.sessionState.updateMany({
        where: { sessionId: session.sessionId },
        data: { lockedAt: null, lastSeenAt: new Date() }
    });
    await resetRateLimit(key);
    return {};
}
