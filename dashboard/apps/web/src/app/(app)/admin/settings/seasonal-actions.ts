"use server";

/**
 * The deployment's seasonal switch, each season's dates and switch, and an
 * admin's preview of one. Off is off for every account, whatever each one
 * chose; on leaves it to them.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { getTranslations } from "@/lib/i18n/request";
import { setSeasonPreview } from "@/lib/seasonal-preview";
import { requireAdmin } from "@/lib/session";
import { saveSeasonRule, seasonCalendar, setSeasonsAllowed } from "@/lib/seasonal-service";

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

/** What saving a season answers: the calendar now in force, or why not. `field`
 *  names the date the refusal is about, for the screen to mark. */
export type SeasonRuleResult =
    { calendar: core.SeasonCalendar; error?: undefined } | { error: string; field?: "from" | "to" };

const seasonSchema = z.enum(core.SEASONS);

/**
 * One season's rule - whether it runs and its window - saved for everybody.
 * Checked against the same schema the screen checks as it is typed, and against
 * the rest of the calendar: two seasons that would share days are refused, with
 * the one in the way named.
 */
export async function saveSeasonRuleAction(
    season: unknown,
    rule: unknown
): Promise<SeasonRuleResult> {
    await requireAdmin();
    const t = await getTranslations("admin");
    const which = seasonSchema.safeParse(season);
    if (!which.success) return { error: t("settings.seasonal.notSaved") };
    const parsed = core.seasonRuleSchema(which.data).safeParse(rule);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field =
            issue?.path[0] === "to" ? "to" : issue?.path[0] === "from" ? "from" : undefined;
        return {
            error:
                issue?.message === "dayOutOfMonth"
                    ? t("settings.seasonal.dayOutOfMonth")
                    : t("settings.seasonal.notSaved"),
            ...(field ? { field } : {})
        };
    }
    const { enabled, from, to } = parsed.data;
    const next: core.SeasonRule = { enabled, window: { from, to } };
    try {
        const current = await seasonCalendar();
        const clash = core.seasonOverlaps({ ...current, [which.data]: next }, which.data)[0];
        if (clash) {
            const names = await getTranslations("nav");
            return { error: t("settings.seasonal.overlaps", { season: names(`season.${clash}`) }) };
        }
        const calendar = await saveSeasonRule(which.data, next);
        revalidatePath("/", "layout");
        return { calendar };
    } catch (caught) {
        console.error("[seasonal] season not saved", caught);
        return { error: t("settings.seasonal.notSaved") };
    }
}

/** Try a season on, for this session alone, whatever its dates or switch say. */
export async function previewSeasonAction(season: unknown): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const parsed = seasonSchema.safeParse(season);
    if (!parsed.success) {
        const t = await getTranslations("admin");
        return { error: t("settings.seasonal.previewFailed") };
    }
    await setSeasonPreview(user.sessionId, parsed.data);
    revalidatePath("/", "layout");
    return {};
}
