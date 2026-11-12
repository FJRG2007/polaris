"use server";

import { requireAdmin } from "@/lib/session";
import { getUpdateSource } from "@/lib/update-source";
import { getAutoUpdatePolicy } from "@/lib/update-watcher";

/** The update policy and source. */
export async function loadUpdatesAdminAction() {
    await requireAdmin();
    const [policy, source] = await Promise.all([getAutoUpdatePolicy(), getUpdateSource()]);
    return { policy, source };
}
