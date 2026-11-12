"use server";

/**
 * Opening an app kept behind the account's PIN (locking one is in
 * `app-launcher-actions`, with the rest of the app menu).
 *
 * It acts on the real account behind the session: an administrator viewing
 * Polaris as somebody else locks and unlocks their own apps, never the other
 * account's. The PIN is four to six digits, so attempts are counted per
 * session with the same budget as the dashboard's own lock screen.
 */

import { verifyQuickPin } from "@polaris/auth";
import { auth } from "@/lib/auth";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { recordAppUnlock } from "@/lib/app-lock-service";
import { unlockAppSchema } from "@/lib/app-locks";

/** Attempts allowed per session before the window closes. */
const APP_UNLOCK_LIMIT = 5;
const APP_UNLOCK_WINDOW_MS = 10 * 60 * 1000;

export async function unlockAppAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("auth");
    const parsed = unlockAppSchema.safeParse(input);
    if (!parsed.success) return { error: t("lock.errors.wrongPin") };

    const key = `app-unlock:${user.sessionId}`;
    const throttle = await rateLimit(key, APP_UNLOCK_LIMIT, APP_UNLOCK_WINDOW_MS);
    if (!throttle.ok) {
        return { error: t("lock.errors.tooMany", { minutes: Math.ceil(throttle.retryAfterMs / 60000) }) };
    }

    const owner = user.viewingAs?.actorId ?? user.id;
    if (!(await verifyQuickPin(auth, owner, parsed.data.pin))) {
        await recordAudit({
            actorId: owner,
            action: "account.app-unlock.failed",
            targetType: "app",
            targetId: parsed.data.appId,
            metadata: {}
        });
        return { error: t("lock.errors.wrongPin") };
    }
    await recordAppUnlock(user.sessionId, parsed.data.appId);
    await resetRateLimit(key);
    return {};
}
