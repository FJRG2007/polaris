"use server";

import { getCapabilities } from "@polaris/config";
import { requireAdmin } from "@/lib/session";
import { DEFAULT_QUIET_HOUR, quietHour } from "@/lib/update-changelog";
import { getUpdateSource } from "@/lib/update-source";
import { getAutoUpdatePolicy } from "@/lib/update-watcher";

/** The update policy and source, the hour "quiet" means here, and whether this
 *  host can install an update on its own at all. */
export async function loadUpdatesAdminAction() {
    await requireAdmin();
    const [policy, source, hour] = await Promise.all([
        getAutoUpdatePolicy(),
        getUpdateSource(),
        quietHour().catch(() => DEFAULT_QUIET_HOUR)
    ]);
    return { policy, source, quietHour: hour, canInstall: getCapabilities().autoUpdate };
}
