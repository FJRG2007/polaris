"use server";

/**
 * Disconnecting an app a person connected over OAuth. Every token it holds
 * stops working at once; the app has to come back through the consent screen
 * to be connected again.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { revokeConnectedApp } from "@/lib/mcp/oauth/grants";

const idSchema = z.string().uuid();

export async function disconnectAppAction(id: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("mcp");
    const parsed = idSchema.safeParse(id);
    // Disconnecting is never refused for a new device or a view: taking access
    // away is the one change that is always safe to allow.
    if (!parsed.success || user.viewingAs) return { error: t("connectedApps.failed") };
    const done = await revokeConnectedApp(user.id, parsed.data);
    if (!done) return { error: t("connectedApps.failed") };
    await recordAudit({
        actorId: user.id,
        action: "account.oauth.disconnected",
        targetType: "oauthGrant",
        targetId: parsed.data
    });
    revalidatePath("/account/api-keys");
    return {};
}
