"use client";

/**
 * The favorites store's shape, apart from the provider that saves it - so a
 * component that only reads it (the rail) does not pull the server action that
 * writes it into its module graph. See `favorite-apps`.
 */

import { createContext, useContext } from "react";

export interface FavoriteApps {
    /** Every stored favorite, in order - including any this account cannot open
     *  today, which are kept for when it can again. */
    readonly favorites: readonly string[];
    readonly toggle: (appId: string) => void;
    /** Put the favorites on screen in this order; the rest keep their slots. */
    readonly arrange: (visible: readonly string[]) => void;
    readonly launcherOpen: boolean;
    readonly setLauncherOpen: (open: boolean) => void;
    /** Open the app menu from elsewhere - after any drawer it was asked from has
     *  closed, since a menu opened under a closing dialog is closed by it. */
    readonly openLauncher: () => void;
}

const NONE: FavoriteApps = {
    favorites: [],
    toggle: () => undefined,
    arrange: () => undefined,
    launcherOpen: false,
    setLauncherOpen: () => undefined,
    openLauncher: () => undefined
};

export const FavoriteAppsContext = createContext<FavoriteApps>(NONE);

export function useFavoriteApps(): FavoriteApps {
    return useContext(FavoriteAppsContext);
}
