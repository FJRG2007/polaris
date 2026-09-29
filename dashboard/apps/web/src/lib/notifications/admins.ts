/**
 * Telling every administrator that something is waiting for one of them.
 *
 * Its own module, small on purpose, because two unrelated things raise it: an
 * account that locked itself down or a person somebody reported (the safety
 * queue), and a message somebody reported (chat). Reaching into the safety queue
 * from chat to borrow this pulled that whole module - and the audit service, and
 * the session layer behind it - into everything that imports a report, which is
 * a lot of weight for one sentence and an unpleasant surprise in a test.
 *
 * Every administrator rather than one: an instance with two has two because
 * either of them may be the one who is around. Best-effort per recipient, so one
 * muted bell cannot swallow the alert for the rest.
 */

import { prisma } from "@polaris/db";
import type * as core from "@polaris/core";
import { notify } from "@/lib/notifications/dispatch";

/** Where all of it is decided, so the alert lands on the queue rather than on
 *  one of the two screens that feed it. */
const QUEUE_HREF = "/admin/safety";

export async function alertAdmins(input: {
    title: string;
    body: string;
    /** Whether this is a decision waiting on a person, as opposed to something
     *  they are being told. It is what makes the alert reach somebody who has
     *  turned the quiet ones off. */
    actionRequired: boolean;
    /** The same words in one administrator's language, when the caller has
     *  them in a catalog. Each administrator reads their own; `title` and
     *  `body` are what is said when their language cannot be looked up. */
    say?: (locale: core.Locale) => { title: string; body: string };
}): Promise<void> {
    const admins = await prisma.user.findMany({
        where: { isAdmin: true, bannedAt: null, disabledAt: null },
        select: { id: true }
    });
    for (const admin of admins) {
        const words = input.say ? await inTheirLanguage(admin.id, input.say) : null;
        await notify({
            userId: admin.id,
            event: "admin.safety.case",
            title: words?.title ?? input.title,
            body: words?.body ?? input.body,
            href: QUEUE_HREF,
            actionRequired: input.actionRequired
        }).catch(() => undefined);
    }
}

/** The words in one person's language, or null when that cannot be looked up.
 *  The locale service is loaded when asked for: this module is imported by code
 *  that also runs where the session layer does not. */
async function inTheirLanguage(
    userId: string,
    say: (locale: core.Locale) => { title: string; body: string }
): Promise<{ title: string; body: string } | null> {
    try {
        const { getUserLocale } = await import("@/lib/i18n/locale-service");
        return say(await getUserLocale(userId));
    } catch {
        return null;
    }
}
