"use server";

/**
 * The account's seasonal switches: the decoration, and the alternate sounds.
 * Saved on the account, so they hold on every device it signs in on.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { saveSeasonalChoice } from "@/lib/seasonal-service";

export async function saveSeasonalAction(
    input: unknown
): Promise<{ choice?: core.SeasonalChoice; error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("account");
    const parsed = core.seasonalPrefsSchema.safeParse(input);
    if (!parsed.success) return { error: t("seasonal.notSaved") };
    try {
        const choice = await saveSeasonalChoice(user.id, parsed.data);
        // The decoration is drawn by the frame, which the layout renders.
        revalidatePath("/", "layout");
        return { choice };
    } catch (caught) {
        console.error("[seasonal] save failed", caught);
        return { error: t("seasonal.notSaved") };
    }
}
