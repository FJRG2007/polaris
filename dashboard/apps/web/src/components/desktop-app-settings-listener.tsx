"use client";

/**
 * Tells the desktop app that this page draws its settings (Settings > This
 * app), so the tray, the app menu and its shortcut open them here instead of
 * the app's own page, and opens the category the app asks for.
 *
 * Said once per document: the app forgets it on a full navigation or a reload,
 * and this mounts again on the page that follows.
 *
 * It also asks the service worker to keep every category's page, so each one
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
            const category = readAppSettingCategory(raw);
            if (category) router.push(`/account/app/${category}`);
        });
        void settings.announce().catch(() => undefined);
        keepCategoryPages(APP_SETTING_CATEGORIES);
        return stop;
    }, [settings, router]);

    useEffect(() => {
        if (phone && !settings) keepCategoryPages(APP_PHONE_CATEGORIES);
    }, [phone, settings]);

    return null;
}

function keepCategoryPages(categories: readonly string[]): void {
    if (!("serviceWorker" in navigator) || !navigator.onLine) return;
    const paths = categories.map((category) => `/account/app/${category}`);
    void navigator.serviceWorker.ready
        .then((registration) => registration.active?.postMessage({ type: "keep-pages", paths }))
        .catch(() => undefined);
}
