"use server";

import { requireAdmin } from "@/lib/session";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { getInstanceSecurity } from "@/lib/instance-security";
import { playerAddressesShared } from "@/lib/player-address-policy";
import { phoneSenderReady } from "@/lib/messaging/code-senders";

/** The sign-in rules and what they depend on, asked for after the paint. */
export async function loadSecurityAdminAction() {
    await requireAdmin();
    const [policy, mail, addressesShared, phoneReady] = await Promise.all([
        getInstanceSecurity(),
        getAuthMailStatus(),
        playerAddressesShared(),
        // A phone is confirmed with a WhatsApp or SMS code, so requiring one needs a sender.
        phoneSenderReady()
    ]);
    return { policy, mailReady: mail.channelId !== null, addressesShared, phoneReady };
}
