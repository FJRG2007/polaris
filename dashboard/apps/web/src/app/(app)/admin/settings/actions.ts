"use server";

/** General settings server actions. Gated to admins. */

import { requireAdmin } from "@/lib/session";
import { legalContactSchema } from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";
import { setLegalContact } from "@/lib/legal/service";

/**
 * Change the address shown on the public pages.
 *
 * Its own action rather than part of anything else: those pages are what an
 * outside review desk reads, and this is the one line on them a deployment gets
 * to write. Empty clears it, which publishes no contact at all.
 */
export async function saveLegalContactAction(
    input: unknown
): Promise<{ contact?: string; error?: string }> {
    await requireAdmin();
    const parsed = legalContactSchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("admin"))("settings.errors.notAContact")
        };
    await setLegalContact(parsed.data || null);
    return { contact: parsed.data };
}
