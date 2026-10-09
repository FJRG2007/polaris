/**
 * The trace a session leaves when it signs itself out.
 *
 * An account's history is meant to answer "where is this signed in, and when did
 * that stop", and a sign-out that left nothing behind was the one gap in it. Shared
 * by the sign-out on every screen and by the account switcher, which signs out
 * accounts that are not the one the browser is acting as.
 */

import { sessionName } from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { translate } from "@/lib/i18n/translate";
import { getUserLocale } from "@/lib/i18n/locale-service";
import { notifySessionsClosed } from "@/lib/notifications/session-events";

/** Record that `sessionId`, one of `userId`'s, is signing out. Called while the
 *  session still exists, which is what lets it be attributed at all. */
export async function noteSignedOut(userId: string, sessionId: string): Promise<void> {
    await recordAudit({
        actorId: userId,
        action: "account.session.signed-out",
        targetType: "session",
        targetId: sessionId,
        sessionId
    });
    await notifySessionsClosed({
        userId,
        count: 1,
        reason: translate(await getUserLocale(userId), "accountSecurity.sessions.signedItselfOut", {
            name: sessionName(sessionId)
        })
    });
}
