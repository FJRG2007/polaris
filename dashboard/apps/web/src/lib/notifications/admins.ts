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
}): Promise<void> {
    const admins = await prisma.user.findMany({
        where: { isAdmin: true, bannedAt: null, disabledAt: null },
        select: { id: true }
    });
    for (const admin of admins) {
        await notify({
            userId: admin.id,
            event: "admin.safety.case",
            title: input.title,
            body: input.body,
            href: QUEUE_HREF,
            actionRequired: input.actionRequired
        }).catch(() => undefined);
    }
}
