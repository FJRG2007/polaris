"use server";

import { getAuthMailStatus } from "@/lib/auth-mail";
import { listEmailChannels } from "@/lib/mail-service";
import { requirePermission, sessionCan } from "@/lib/session";
import { listSmsSenders } from "@/lib/notifications/sms-service";

/** The reader's senders, and for the operator the channel account mail leaves through. */
export async function loadEmailAdminAction() {
    const user = await requirePermission("inbox.read");
    const [canManage, senders, smsSenders, everyChannel, status] = await Promise.all([
        sessionCan(user, "inbox.manage"),
        listEmailChannels(user.id),
        listSmsSenders(user.id),
        user.isAdmin ? listEmailChannels() : Promise.resolve([]),
        user.isAdmin ? getAuthMailStatus() : Promise.resolve(null)
    ]);
    return {
        canManage,
        senders,
        smsSenders,
        accountMail: status ? { channels: everyChannel, selectedId: status.channelId } : null
    };
}
