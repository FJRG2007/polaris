"use server";

/**
 * How somebody's Overview is stored. Validated against the same schema the grid
 * is resolved from, so a hand-written payload cannot store a card that does not
 * exist or a link that leaves Polaris.
 *
 * Cards are deliberately not filtered by permission on the way in. A layout is a
 * preference, not a grant: what may be drawn is decided when the grid is
 * resolved, so somebody who loses access to Deploy for a week gets their card
 * back where they left it rather than having it quietly deleted.
 */

import { requireUser } from "@/lib/session";
import { overviewPreferencesSchema } from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";
import { getOverviewPreferences, saveOverviewPreferences } from "@/lib/overview/prefs-service";

export async function saveOverviewPreferencesAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = overviewPreferencesSchema.safeParse(input);
    if (!parsed.success) {
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("home"))("errors.layoutNotSaved")
        };
    }
    // The apps' cards are saved on their own (`saveAppWidgetsAction`). A save
    // from a screen that does not send them - which is every save of the grid,
    // and every tab opened before apps could add cards - keeps the stored ones
    // rather than writing them away.
    const sent = typeof input === "object" && input !== null && "appWidgets" in input;
    const appWidgets = sent
        ? parsed.data.appWidgets
        : (await getOverviewPreferences(user.id)).appWidgets;
    await saveOverviewPreferences(user.id, { ...parsed.data, appWidgets });
    return {};
}
