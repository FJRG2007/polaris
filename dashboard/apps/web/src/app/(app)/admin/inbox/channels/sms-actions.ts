"use server";

/**
 * SMS-sender actions, beside the email-channel ones for the same reason: nothing
 * here touches the bridge. A text is posted to the provider by this process, so
 * the sender is stored and its credential checked in the request that asked.
 *
 * They live with the channels rather than under a user's own notification
 * settings, which is where they used to be. A sender is a connected service the
 * whole deployment sends through - the same kind of thing as a mail sender or a
 * WhatsApp number - not a preference belonging to one person's account, and
 * asking somebody who only wanted a Discord webhook for provider credentials was
 * putting an operator's job on a personal settings page.
 *
 * Ownership matches its siblings here: a sender belongs to whoever connected it.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { smsChannelInputSchema } from "@polaris/core";
import { deleteSmsSender, saveSmsSender, type SmsSenderView } from "@/lib/notifications/sms-service";
import { deliveryText } from "@/lib/notifications/delivery-words";

export async function saveSmsSenderAction(
    input: unknown
): Promise<{ sender?: SmsSenderView; error?: string }> {
    const user = await requirePermission("inbox.manage");
    const parsed = smsChannelInputSchema.extend({ id: z.string().uuid().optional() }).safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? (await getTranslations("admin"))("inboxChannels.errors.checkForm") };
    }
    const result = await saveSmsSender(user.id, parsed.data);
    if (!result.error) revalidatePath("/admin/inbox/channels");
    // The sender answers in English; the reader gets their own words.
    return result.error ? { ...result, error: deliveryText(await getTranslations("notices"), result.error) } : result;
}

export async function deleteSmsSenderAction(id: unknown): Promise<void> {
    const user = await requirePermission("inbox.manage");
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) return;
    await deleteSmsSender(user.id, parsed.data);
    revalidatePath("/admin/inbox/channels");
}
