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
 * be arranged sends - and keeps the arrangement already stored. Whatever a save
 * does not name, an older tab's included, keeps its stored opening app.
 */

import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { launcherPrefsSchema } from "@/lib/app-launcher";
import { getLauncherPrefs, saveLauncherPrefs } from "@/lib/app-launcher-service";
import { setAppLock } from "@/lib/app-lock-service";
import { setAppLockSchema } from "@/lib/app-locks";
import type { NotificationHolds } from "@polaris/core";
import { updateNotificationHolds } from "@/lib/notifications/preferences";
import { applyAppMute, mutableApp, setAppMuteSchema } from "@/lib/app-mutes";

export async function saveFavoriteAppsAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = launcherPrefsSchema.safeParse(input);
    // The schema's own words are English and name internals; the reader gets
    // the sentence in their language, and the menu puts their list back.
    if (!parsed.success)
        return { error: (await getTranslations("nav"))("errors.favoritesNotSaved") };
    const stored = await getLauncherPrefs(user.id);
    const prefs = Array.isArray(parsed.data)
        ? { favorites: parsed.data, order: stored.order, home: stored.home }
        : { ...parsed.data, home: parsed.data.home === undefined ? stored.home : parsed.data.home };
    await saveLauncherPrefs(user.id, prefs);
    return {};
}

/**
 * Keep an app behind the account's PIN, or stop. Acts on the real account
 * behind the session, never one an administrator is viewing as. Refused
 * without a PIN, and for the account and Settings (see `app-locks`).
 */
export async function setAppLockAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("nav");
    const parsed = setAppLockSchema.safeParse(input);
    if (!parsed.success) return { error: t("switcher.lockFailed") };
    const owner = user.viewingAs?.actorId ?? user.id;
    const saved = await setAppLock(owner, parsed.data.appId, parsed.data.locked);
    return saved ? {} : { error: t("switcher.lockNeedsPinFirst") };
}

/**
 * Mute a whole app's notifications for a while, or unmute it. Saved in the
 * account's notification holds, so Account > Notifications lists it and lifts
 * it too. The end is worked out on the server's clock; an app with no alerts
 * is refused.
 */
export async function setAppMuteAction(
    input: unknown
): Promise<{ holds?: NotificationHolds; error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("nav");
    const parsed = setAppMuteSchema.safeParse(input);
    if (!parsed.success || !mutableApp(parsed.data.appId)) return { error: t("switcher.muteFailed") };
    const { appId, duration } = parsed.data;
    const holds = await updateNotificationHolds(user.id, (current) =>
        applyAppMute(current, appId, duration, new Date())
    );
    return { holds };
}
