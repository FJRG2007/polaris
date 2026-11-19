"use client";

/**
 * Who has the bottom of a phone's screen: the shell's tab bar (`phone-tabs.tsx`)
 * or a screen that draws tabs of its own and calls `useOwnBottomTabs()`.
 *
 * Its own module, with nothing imported, so a screen can take the bottom without
 * loading the bar's app list, notifications and account data along with it.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const PhoneTabsContext = createContext<{ owned: boolean; own: () => () => void }>({
    owned: false,
    own: () => () => undefined
});

/** Holds whether a screen has taken the bottom of the phone for its own tabs. */
export function PhoneTabsProvider({ children }: { children: ReactNode }) {
    const [owners, setOwners] = useState(0);
    const own = useCallback(() => {
        setOwners((count) => count + 1);
        return () => setOwners((count) => count - 1);
    }, []);
    const value = useMemo(() => ({ owned: owners > 0, own }), [owners, own]);
    return <PhoneTabsContext.Provider value={value}>{children}</PhoneTabsContext.Provider>;
}

/** For a screen that draws its own BottomTabs: the shell's bar steps aside
 *  while the screen is mounted. */
export function useOwnBottomTabs(): void {
    const { own } = useContext(PhoneTabsContext);
    useEffect(() => own(), [own]);
}

/** `useOwnBottomTabs` as an element, for a server layout. */
export function OwnBottomTabs(): null {
    useOwnBottomTabs();
    return null;
}

/** Whether a screen has taken the bottom, for the shell's bar to step aside. */
export function useBottomTabsOwned(): boolean {
    return useContext(PhoneTabsContext).owned;
}
