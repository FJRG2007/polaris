"use server";

/**
 * Saving the apps somebody chose as favorites and the order they arranged the
 * app menu in. Both lists are sent whole rather than one change, so a repeated
 * or reordered save lands on the same answer.
 *
 * Not filtered by permission on the way in, for the reason the Overview layout
 * is not: a pin is a preference, not a grant. What is drawn is decided against
 * the apps the account can open when the switcher is rendered, so somebody who
 * loses an app for a week finds it where they left it when it comes back.
 *
 * A bare list is the favorites alone - what a tab loaded before the menu could
 * be arranged sends - and keeps the arrangement already stored.
 */

import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { launcherPrefsSchema } from "@/lib/app-launcher";
import { getLauncherPrefs, saveLauncherPrefs } from "@/lib/app-launcher-service";

export async function saveFavoriteAppsAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = launcherPrefsSchema.safeParse(input);
    // The schema's own words are English and name internals; the reader gets
    // the sentence in their language, and the menu puts their list back.
    if (!parsed.success)
        return { error: (await getTranslations("nav"))("errors.favoritesNotSaved") };
    const prefs = Array.isArray(parsed.data)
        ? { favorites: parsed.data, order: (await getLauncherPrefs(user.id)).order }
        : parsed.data;
    await saveLauncherPrefs(user.id, prefs);
    return {};
}
