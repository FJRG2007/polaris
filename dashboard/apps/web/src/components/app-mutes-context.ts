"use client";

/**
 * The account's notification holds as the app menu reads them, to say which
 * apps are muted. A module of its own, apart from the provider, so a menu that
 * only reads them does not pull the server action in with it.
 */

import { createContext, useContext } from "react";
import type { NotificationHolds, NotificationMuteDuration } from "@polaris/core";

export interface AppMutesState {
    readonly holds: NotificationHolds;
    /** Mute the app's notifications for a while, or null to let them through. */
    readonly mute: (appId: string, duration: NotificationMuteDuration | null) => void;
}

export const AppMutesContext = createContext<AppMutesState>({
    holds: { mutes: {}, schedules: {} },
    mute: () => undefined
});

export function useAppMutes(): AppMutesState {
    return useContext(AppMutesContext);
}
