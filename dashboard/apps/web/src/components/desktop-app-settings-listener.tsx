"use client";

/**
 * Tells the desktop app that this page draws its settings (Settings > This
 * app), so the tray, the app menu and its shortcut open them here instead of
 * the app's own page, and opens the category the app asks for.
 *
 * Said once per document: the app forgets it on a full navigation or a reload,
 * and this mounts again on the page that follows.
 *
 * It also asks the service worker to keep every category's page (and the
 * device add-ons' and Downloads', where the app's updates are), so each one
 * opens with the host out of reach even if it was never opened here before (a
 * page the worker kept is what a navigation gets offline). The phone app's
 * categories are kept the same way inside the phone app.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useDesktopBridge, usePhoneAppSettings } from "@/components/desktop-app";
import { APP_PHONE_CATEGORIES, APP_SETTING_CATEGORIES, readAppSettingCategory } from "@polaris/core/app-settings";

export function DesktopAppSettingsListener() {
    const settings = useDesktopBridge()?.appSettings;
    const router = useRouter();
    const phone = usePhoneAppSettings();

    useEffect(() => {
        if (!settings) return;
        const stop = settings.onOpen((raw) => {
            // The app's version and updates moved to Downloads; an app built
            // before that may still ask for them by their old category.
            if (raw === "updates") return router.push(DOWNLOADS_PATH);
            const category = readAppSettingCategory(raw);
            if (category) router.push(`/account/app/${category}`);
        });
        // Hosts are drawn here only by an app that manages them through the page.
        void settings.announce(settings.hosts ? ["hosts"] : []).catch(() => undefined);
        keepCategoryPages(APP_SETTING_CATEGORIES, [DEVICE_ADDONS_PATH, DOWNLOADS_PATH]);
        return stop;
    }, [settings, router]);

    useEffect(() => {
        if (phone && !settings) keepCategoryPages(APP_PHONE_CATEGORIES, [DOWNLOADS_PATH]);
    }, [phone, settings]);

    return null;
}

/** The desktop's device add-ons, listed in its settings after the categories. */
const DEVICE_ADDONS_PATH = "/account/addons";

/** Where the app's version, its check for updates and its restart into one are. */
const DOWNLOADS_PATH = "/account/downloads";

function keepCategoryPages(categories: readonly string[], more: readonly string[] = []): void {
    if (!("serviceWorker" in navigator) || !navigator.onLine) return;
    const paths = [...categories.map((category) => `/account/app/${category}`), ...more];
    void navigator.serviceWorker.ready
        .then((registration) => registration.active?.postMessage({ type: "keep-pages", paths }))
        .catch(() => undefined);
}
