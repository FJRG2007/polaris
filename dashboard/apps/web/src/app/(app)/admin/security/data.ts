"use server";

import { requireAdmin } from "@/lib/session";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { getInstanceSecurity } from "@/lib/instance-security";
import { playerAddressesShared } from "@/lib/player-address-policy";

/** The sign-in rules and what they depend on, asked for after the paint. */
export async function loadSecurityAdminAction() {
    await requireAdmin();
    const [policy, mail, addressesShared] = await Promise.all([
        getInstanceSecurity(),
        getAuthMailStatus(),
        playerAddressesShared()
    ]);
    return { policy, mailReady: mail.channelId !== null, addressesShared };
}
