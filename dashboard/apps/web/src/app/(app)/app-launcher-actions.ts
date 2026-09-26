"use server";

/**
 * Pinning apps to the top of the switcher. The whole list is sent rather than
 * one change, so a repeated or reordered save lands on the same answer.
 *
 * Not filtered by permission on the way in, for the reason the Overview layout
 * is not: a pin is a preference, not a grant. What is drawn is decided against
 * the apps the account can open when the switcher is rendered, so somebody who
 * loses an app for a week finds it pinned where they left it when it comes back.
 */

import { requireUser } from "@/lib/session";
import { favoriteAppsSchema } from "@/lib/app-launcher";
import { saveFavoriteApps } from "@/lib/app-launcher-service";

export async function saveFavoriteAppsAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = favoriteAppsSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Those favorites could not be saved." };
    await saveFavoriteApps(user.id, parsed.data);
    return {};
}
