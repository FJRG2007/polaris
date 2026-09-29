/**
 * Telling somebody their account was signed in to, or signed out of.
 *
 * The two halves of the same question - who is holding this account right now -
 * so they are worded and routed from one place rather than at each of the eight
 * or so points a session can begin or end.
 *
 * A sign-in alert is the one that catches a stolen password, and it only does so
 * if it says where from: a line naming the browser, the address and the country
 * is the difference between an alert somebody can act on and one they dismiss.
 * Sessions ending are reported by the batch that ended them, not one alert per
 * row - signing eleven devices out is one decision and reads as one.
 */

import { notify } from "./dispatch";
import { wordsFor } from "./notice-words";

/** Every one of these points at the screen where sessions can be ended. */
const SESSIONS_HREF = "/account/sessions";

/**
 * Raise the alert for a session that has just become usable. Called where a
 * sign-in completes, and where one waiting for approval is let in - never for a
 * session still sitting at the approval screen, which has its own alert and is
 * not yet holding anything.
 */
export async function notifySessionOpened(input: { userId: string; origin: string }): Promise<void> {
    const t = await wordsFor(input.userId, "notices");
    await notify({
        userId: input.userId,
        event: "account.session.opened",
        title: t("session.opened"),
        body: input.origin,
        href: SESSIONS_HREF
    });
}

/**
 * Raise the alert for sessions that have just ended, however many and whatever
 * ended them. `reason` says which, in the recipient's terms: they are reading it
 * to find out whether it was them.
 */
export async function notifySessionsClosed(input: {
    userId: string;
    count: number;
    reason: string;
}): Promise<void> {
    if (input.count <= 0) return;
    const t = await wordsFor(input.userId, "notices");
    await notify({
        userId: input.userId,
        event: "account.session.closed",
        title: t("session.closed", { count: input.count }),
        body: input.reason,
        href: SESSIONS_HREF
    });
}
