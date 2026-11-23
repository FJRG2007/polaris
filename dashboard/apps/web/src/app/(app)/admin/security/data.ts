"use server";

import { requireAdmin } from "@/lib/session";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { getInstanceSecurity } from "@/lib/instance-security";
import { playerAddressesShared } from "@/lib/player-address-policy";
import { phoneSenderReady } from "@/lib/messaging/code-senders";
import { passwordMigrationCounts } from "@/lib/chat/e2ee/opaque-service";

/** The sign-in rules and what they depend on, asked for after the paint. */
export async function loadSecurityAdminAction() {
    await requireAdmin();
    const [policy, mail, addressesShared, phoneReady, passwords] = await Promise.all([
        getInstanceSecurity(),
        getAuthMailStatus(),
        playerAddressesShared(),
        // A phone is confirmed with a WhatsApp or SMS code, so requiring one needs a sender.
        phoneSenderReady(),
        passwordMigrationCounts()
    ]);
    return { policy, mailReady: mail.channelId !== null, addressesShared, phoneReady, passwords };
}
