"use client";

/**
 * The apps this account keeps behind its PIN, as the app menu reads them. A
 * module of its own, apart from the provider, so a menu that only reads them
 * does not pull the server action in with it.
 */

import { createContext, useContext } from "react";

export interface AppLocksState {
    readonly locked: readonly string[];
    readonly hasPin: boolean;
    /** Lock the app, or take the lock off it. */
    readonly toggleLock: (appId: string) => void;
    /** Open the screen where the PIN is set. */
    readonly setUpPin: () => void;
}

export const AppLocksContext = createContext<AppLocksState>({
    locked: [],
    hasPin: false,
    toggleLock: () => undefined,
    setUpPin: () => undefined
});

export function useAppLocks(): AppLocksState {
    return useContext(AppLocksContext);
}
