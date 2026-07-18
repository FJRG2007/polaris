"use server";

/**
 * Settings server actions. The update check re-runs the GitHub comparison,
 * bypassing the cache, so the operator gets a fresh answer on demand. Gated to
 * admins: update state and deployment settings are operator surfaces.
 */

import { requireAdmin } from "@/lib/session";
import { getUpdateStatus, type UpdateStatus } from "@/lib/update-service";

export async function checkUpdatesAction(): Promise<UpdateStatus> {
    await requireAdmin();
    return getUpdateStatus(true);
}
