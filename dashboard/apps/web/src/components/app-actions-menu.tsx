"use client";

/**
 * What a right click on an app offers, in the app menu and on the Overview's
 * rail: marking what is waiting in it read, keeping it on the rail, and opening
 * it on entering Polaris, keeping it behind the account's PIN, and muting
 * its notifications for a while. A long press does the same on a touch screen.
 */

import * as core from "@polaris/core";
import { Bell, BellOff, House, Lock, LockOpen, Star } from "lucide-react";
import type { ReactNode } from "react";
import { OVERVIEW_APP_ID } from "@/lib/apps";
import { lockableApp } from "@/lib/app-locks";
import { appMuteState, mutableApp } from "@/lib/app-mutes";
import { useAppLocks } from "@/components/app-locks-context";
import { useAppMutes } from "@/components/app-mutes-context";
import { useDisplayFormat } from "@/components/display-format";
import { useFavoriteApps } from "@/components/favorite-apps-context";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
    type AppTileAction
} from "@polaris/ui";

export function AppActionsMenu({
    appId,
    markRead = null,
    children
}: {
    appId: string;
    /** The app's own "mark read" (see `useLauncherMarks`), or null when it has
     *  nothing waiting that a mark dismisses - then the option is not offered. */
    markRead?: AppTileAction | null;
    children: ReactNode;
}) {
    const t = useTranslations("nav");
    const { favorites, home, toggleFavorite, setHome } = useFavoriteApps();
    const favorite = favorites.includes(appId);
    const { locked, hasPin, toggleLock, setUpPin } = useAppLocks();
    const isLocked = locked.includes(appId);
    const { holds, mute } = useAppMutes();
    const format = useDisplayFormat();
    const now = new Date();
    const muteState = appMuteState(holds, appId, now);
    // Today's end as a time, a later one with its date.
    const untilLabel = (until: string) => {
        const at = new Date(until);
        return format.date(at) === format.date(now) ? format.time(at) : format.dateTime(at);
    };
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <div className="contents">{children}</div>
            </ContextMenuTrigger>
            <ContextMenuContent>
                {markRead ? (
                    <>
                        <ContextMenuItem onSelect={markRead.onSelect}>
                            <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-4 [&_svg]:shrink-0">
                                {markRead.icon}
                            </span>
                            {markRead.label}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                    </>
                ) : null}
                {/* The rail is drawn on the Overview, so it never lists it. */}
                {appId === OVERVIEW_APP_ID ? null : (
                    <ContextMenuItem onSelect={() => toggleFavorite(appId)}>
                        <Star className="size-4 shrink-0" aria-hidden="true" />
                        {t(favorite ? "switcher.unfavorite" : "switcher.favorite")}
                    </ContextMenuItem>
                )}
                <ContextMenuItem onSelect={() => setHome(home === appId ? null : appId)}>
                    <House className="size-4 shrink-0" aria-hidden="true" />
                    {t(home === appId ? "switcher.notStart" : "switcher.start")}
                </ContextMenuItem>
                {/* The account and Settings are where the PIN is set, so they are
                    never offered. Without a PIN the item leads to setting one. */}
                {lockableApp(appId) ? (
                    hasPin ? (
                        <ContextMenuItem onSelect={() => toggleLock(appId)}>
                            {isLocked ? (
                                <LockOpen className="size-4 shrink-0" aria-hidden="true" />
                            ) : (
                                <Lock className="size-4 shrink-0" aria-hidden="true" />
                            )}
                            {t(isLocked ? "switcher.unlockApp" : "switcher.lockApp")}
                        </ContextMenuItem>
                    ) : (
                        <ContextMenuItem onSelect={setUpPin}>
                            <Lock className="size-4 shrink-0" aria-hidden="true" />
                            {t("switcher.lockNeedsPin")}
                        </ContextMenuItem>
                    )
                ) : null}
                {/* Only an app with notifications of its own: muting one with none
                    would be a switch that does nothing. */}
                {mutableApp(appId) ? (
                    muteState.muted ? (
                        <ContextMenuItem onSelect={() => mute(appId, null)}>
                            <Bell className="size-4 shrink-0" aria-hidden="true" />
                            {muteState.until
                                ? t("switcher.unmuteAppUntil", { time: untilLabel(muteState.until) })
                                : t("switcher.unmuteApp")}
                        </ContextMenuItem>
                    ) : (
                        <ContextMenuSub>
                            <ContextMenuSubTrigger>
                                <BellOff className="size-4 shrink-0" aria-hidden="true" />
                                {t("switcher.muteApp")}
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent>
                                {core.NOTIFICATION_MUTE_DURATIONS.map((duration) => (
                                    <ContextMenuItem
                                        key={duration}
                                        onSelect={() => mute(appId, duration)}
                                    >
                                        {t(`switcher.muteFor.${duration}`)}
                                    </ContextMenuItem>
                                ))}
                            </ContextMenuSubContent>
                        </ContextMenuSub>
                    )
                ) : null}
            </ContextMenuContent>
        </ContextMenu>
    );
}
