"use server";

/**
 * The deployment's default units and formats. Admin-only: this is what every
 * account formats against until it picks something of its own, so the change is
 * audited like any other platform setting.
 */

import { revalidatePath } from "next/cache";
import { displayPreferencesSchema } from "@polaris/core";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { savePlatformDisplayPreferences } from "@/lib/display-prefs-service";

export async function savePlatformDisplayAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = displayPreferencesSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Unsupported choice." };
    await savePlatformDisplayPreferences(parsed.data);
    await recordAudit({ actorId: admin.id, action: "admin.display.updated" });
    // Accounts that inherit these follow the change from their next render on.
    revalidatePath("/", "layout");
    return {};
}
