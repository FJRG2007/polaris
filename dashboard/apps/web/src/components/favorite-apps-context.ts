"use client";

/**
 * The favorites store's shape (the favorites and the app menu's order), apart
 * from the provider that saves it - so a component that only reads it (the
 * rail) does not pull the server action that writes it into its module graph.
 * See `favorite-apps`.
 */

import { createContext, useContext } from "react";

export interface FavoriteApps {
    /** The apps somebody marked as favorites, in order: what the Overview's rail
     *  lists. */
    readonly favorites: readonly string[];
    /** The order the app menu was arranged in, kept the same way; empty until
     *  somebody arranges it. */
    readonly order: readonly string[];
    /** The app to open on entering Polaris; null for the usual landing. */
    readonly home: string | null;
    /** Make an app a favorite, or stop it being one. */
    readonly toggleFavorite: (id: string) => void;
    /** Choose the app to open on entering Polaris, or none. */
    readonly setHome: (id: string | null) => void;
    /** Put the app menu in this order; apps not on screen keep their slots. */
    readonly arrangeApps: (visible: readonly string[]) => void;
    /** Forget the arrangement: favorites first and the rest by use again. */
    readonly resetOrder: () => void;
    /** Replace both lists at once - what picking a sidebar preset does. */
    readonly replacePrefs: (prefs: {
        favorites: readonly string[];
        order: readonly string[];
    }) => void;
    readonly launcherOpen: boolean;
    readonly setLauncherOpen: (open: boolean) => void;
    /** Open the app menu from elsewhere - after any drawer it was asked from has
     *  closed, since a menu opened under a closing dialog is closed by it. */
    readonly openLauncher: () => void;
}

const NONE: FavoriteApps = {
    favorites: [],
    order: [],
    home: null,
    toggleFavorite: () => undefined,
    setHome: () => undefined,
    arrangeApps: () => undefined,
    resetOrder: () => undefined,
    replacePrefs: () => undefined,
    launcherOpen: false,
    setLauncherOpen: () => undefined,
    openLauncher: () => undefined
};

export const FavoriteAppsContext = createContext<FavoriteApps>(NONE);

export function useFavoriteApps(): FavoriteApps {
    return useContext(FavoriteAppsContext);
}
