"use server";

import { requireAdmin } from "@/lib/session";
import { getCodeSenders, listSmsCodeSenders } from "@/lib/messaging/code-senders";
import { listMessagingChannels } from "@/lib/messaging/channel-admin";

/** Every messaging channel, the SMS senders that could carry codes, and which ones do. */
export async function loadMessagingAdminAction() {
    await requireAdmin();
    const [channels, codeSenders, smsSenders] = await Promise.all([
        listMessagingChannels(),
        getCodeSenders(),
        listSmsCodeSenders()
    ]);
    return { channels, codeSenders, smsSenders };
}
