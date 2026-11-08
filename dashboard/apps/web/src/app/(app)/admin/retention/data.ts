"use server";

import { requireAdmin } from "@/lib/session";
import { getSetting } from "@/lib/setting-store";
import { retentionPolicy } from "@/lib/retention-service";
import { MAIL_BODY_KEEP_KEY, mailBodyKeep } from "@polaris/core";

/** The retention policy and how long mail bodies are kept. */
export async function loadRetentionAction() {
    await requireAdmin();
    const [policy, storedKeep] = await Promise.all([
        retentionPolicy(),
        getSetting(MAIL_BODY_KEEP_KEY)
    ]);
    return { policy, kept: mailBodyKeep(storedKeep) };
}
