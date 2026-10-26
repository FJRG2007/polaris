"use server";

/**
 * The server's own address on the network moved, for the banner that says so to
 * whoever manages this Polaris. Read from the history the address follower
 * writes; nothing here touches the network.
 */

import { getSetting } from "@/lib/setting-store";
import { requireUser, sessionCan } from "@/lib/session";
import { LAN_HISTORY_KEY, recentLanMove, type LanMove } from "@/lib/lan-address-follow";

/** The newest move while it is recent, or null - also for anyone who does not
 *  manage the system, who could not act on it. */
export async function lanAddressMoveAction(): Promise<LanMove | null> {
    const user = await requireUser();
    if (!(await sessionCan(user, "system.manage"))) return null;
    return recentLanMove(await getSetting(LAN_HISTORY_KEY));
}
