"use client";

/**
 * Tells the desktop app that this page draws its settings (Settings > This
 * app), so the tray, the app menu and its shortcut open them here instead of
 * the app's own page, and opens the category the app asks for.
 *
 * Said once per document: the app forgets it on a full navigation or a reload,
 * and this mounts again on the page that follows.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { readAppSettingCategory } from "@polaris/core/app-settings";
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
        return stop;
    }, [settings, router]);

    return null;
}
