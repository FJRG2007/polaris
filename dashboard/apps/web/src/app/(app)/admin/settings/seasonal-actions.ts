"use server";

/**
 * The deployment's seasonal switch. Off is off for every account, whatever each
 * one chose; on leaves it to them.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { setSeasonsAllowed } from "@/lib/seasonal-service";

export async function setSeasonsAllowedAction(allowed: unknown): Promise<{ error?: string }> {
    await requireAdmin();
    const parsed = z.boolean().safeParse(allowed);
    const t = await getTranslations("admin");
    if (!parsed.success) return { error: t("settings.seasonal.notSaved") };
    try {
        await setSeasonsAllowed(parsed.data);
    } catch (caught) {
        console.error("[seasonal] switch failed", caught);
        return { error: t("settings.seasonal.notSaved") };
    }
    revalidatePath("/", "layout");
    return {};
}
