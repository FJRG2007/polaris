"use client";

/**
 * What a right click on an app offers, in the app menu and on the Overview's
 * rail: keeping it on the rail, and opening it on entering Polaris. A long press
 * does the same on a touch screen.
 */

import { House, Star } from "lucide-react";
import type { ReactNode } from "react";
import { OVERVIEW_APP_ID } from "@/lib/apps";
import { useFavoriteApps } from "@/components/favorite-apps-context";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@polaris/ui";

export function AppActionsMenu({ appId, children }: { appId: string; children: ReactNode }) {
    const t = useTranslations("nav");
    const { favorites, home, toggleFavorite, setHome } = useFavoriteApps();
    const favorite = favorites.includes(appId);
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <div className="contents">{children}</div>
            </ContextMenuTrigger>
            <ContextMenuContent>
                {/* The rail is drawn on the Overview, so it never lists it. */}
                {appId === OVERVIEW_APP_ID ? null : (
                    <ContextMenuItem onSelect={() => toggleFavorite(appId)}>
                        <Star className="size-4" aria-hidden="true" />
                        {t(favorite ? "switcher.unfavorite" : "switcher.favorite")}
                    </ContextMenuItem>
                )}
                <ContextMenuItem onSelect={() => setHome(home === appId ? null : appId)}>
                    <House className="size-4" aria-hidden="true" />
                    {t(home === appId ? "switcher.notStart" : "switcher.start")}
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}
