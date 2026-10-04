"use client";

/**
 * The favorites store's shape (the favorites and the app menu's order), apart
 * from the provider that saves it - so a component that only reads it (the
 * rail) does not pull the server action that writes it into its module graph.
 * See `favorite-apps`.
 */

import { createContext, useContext } from "react";

export interface FavoriteApps {
    /** The favorites an older app menu saved with its star, in order - kept, and
     *  read as before, until the menu is arranged; see `arrangedPrefs`. */
    readonly favorites: readonly string[];
    /** The order the app menu was arranged in, kept the same way; empty until
     *  somebody arranges it. */
    readonly order: readonly string[];
    /** Put the app menu in this order; apps not on screen keep their slots. */
    readonly arrangeApps: (visible: readonly string[]) => void;
    /** Forget the arrangement: favorites first and the rest by use again. */
    readonly resetOrder: () => void;
    readonly launcherOpen: boolean;
    readonly setLauncherOpen: (open: boolean) => void;
    /** Open the app menu from elsewhere - after any drawer it was asked from has
     *  closed, since a menu opened under a closing dialog is closed by it. */
    readonly openLauncher: () => void;
}

const NONE: FavoriteApps = {
    favorites: [],
    order: [],
    arrangeApps: () => undefined,
    resetOrder: () => undefined,
    launcherOpen: false,
    setLauncherOpen: () => undefined,
    openLauncher: () => undefined
};

export const FavoriteAppsContext = createContext<FavoriteApps>(NONE);

export function useFavoriteApps(): FavoriteApps {
    return useContext(FavoriteAppsContext);
}
