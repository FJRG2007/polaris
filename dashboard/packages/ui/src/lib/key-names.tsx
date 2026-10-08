"use client";

/**
 * What the reader's keyboard calls its named keys - "Supr" for Delete on a
 * Spanish one - handed down once by the frame so every printed shortcut, in a
 * menu or a help sheet, uses those words. Without a provider the English names
 * are used, which is what they always were.
 */

import { createContext, useContext, type ReactNode } from "react";

const KeyNames = createContext<Readonly<Record<string, string>> | undefined>(undefined);

export function KeyNamesProvider({
    names,
    children
}: {
    /** By the key's lowercase name: `delete`, `enter`, `space`... */
    names: Readonly<Record<string, string>>;
    children: ReactNode;
}) {
    return <KeyNames.Provider value={names}>{children}</KeyNames.Provider>;
}

/** The reader's words for named keys, or undefined for the English ones. */
export function useKeyNames(): Readonly<Record<string, string>> | undefined {
    return useContext(KeyNames);
}
