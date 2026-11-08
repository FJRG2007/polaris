"use server";

import { requireAdmin } from "@/lib/session";
import { isAppInstalled } from "@/lib/apps/install-presence";

/** What the Management overview needs to know: only whether the inbox exists here. */
export async function loadManagementOverviewAction() {
    await requireAdmin();
    return { inbox: await isAppInstalled("messaging-bridge") };
}
