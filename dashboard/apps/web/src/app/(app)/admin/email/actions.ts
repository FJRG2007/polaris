"use server";

/**
 * Choosing which email channel carries account mail. Administrators only: the
 * choice applies to everyone on the deployment, not to the account that makes it.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordAudit } from "@/lib/audit-service";
import { requireAdmin } from "@/lib/session";
import { setAuthMailChannel } from "@/lib/auth-mail";

const choiceSchema = z.string().uuid().nullable();

export async function setAuthMailChannelAction(channelId: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = choiceSchema.safeParse(channelId === "" ? null : channelId);
    if (!parsed.success) return { error: "Unknown channel." };
    const result = await setAuthMailChannel(parsed.data);
    if (!result.error) {
        await recordAudit({
            actorId: admin.id,
            action: parsed.data ? "auth-mail.channel.set" : "auth-mail.channel.cleared",
            targetType: "channel",
            targetId: parsed.data ?? undefined
        });
        revalidatePath("/admin/email");
    }
    return result;
}
