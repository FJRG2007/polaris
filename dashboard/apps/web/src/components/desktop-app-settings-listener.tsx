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
 * page the worker kept is what a navigation gets offline).
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { APP_SETTING_CATEGORIES, readAppSettingCategory } from "@polaris/core/app-settings";
import { useDesktopBridge } from "@/components/desktop-app";

export function DesktopAppSettingsListener() {
    const settings = useDesktopBridge()?.appSettings;
    const router = useRouter();

    useEffect(() => {
        if (!settings) return;
        const stop = settings.onOpen((raw) => {
            const category = readAppSettingCategory(raw);
            if (category) router.push(`/account/app/${category}`);
        });
        void settings.announce().catch(() => undefined);
        keepCategoryPages();
        return stop;
    }, [settings, router]);

    return null;
}

function keepCategoryPages(): void {
    if (!("serviceWorker" in navigator) || !navigator.onLine) return;
    const paths = APP_SETTING_CATEGORIES.map((category) => `/account/app/${category}`);
    void navigator.serviceWorker.ready
        .then((registration) => registration.active?.postMessage({ type: "keep-pages", paths }))
        .catch(() => undefined);
}
