"use server";

import { requireAdmin } from "@/lib/session";
import { getCodeSenders } from "@/lib/messaging/code-senders";
import { listMessagingChannels } from "@/lib/messaging/channel-admin";

/** Every messaging channel, and which ones carry verification codes. */
export async function loadMessagingAdminAction() {
    await requireAdmin();
    const [channels, codeSenders] = await Promise.all([listMessagingChannels(), getCodeSenders()]);
    return { channels, codeSenders };
}
