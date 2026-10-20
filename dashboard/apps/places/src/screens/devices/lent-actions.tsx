"use client";

/**
 * What a visitor may do with each device they were lent - open, close,
 * operate - handed to every set of controls under it, so a key lent to open a
 * door draws an Open button and no Lock button. A resident is given nothing
 * here: `canControl` already answers for them.
 */

import { createContext, useContext, type ReactNode } from "react";

const LentActions = createContext<Readonly<Record<string, readonly string[]>>>({});

export function LentActionsProvider({
    lent,
    children
}: {
    lent: Readonly<Record<string, readonly string[]>>;
    children: ReactNode;
}) {
    return <LentActions.Provider value={lent}>{children}</LentActions.Provider>;
}

/** What this visitor may do with one device, or an empty list. */
export function useLentActions(deviceId: string): readonly string[] {
    return useContext(LentActions)[deviceId] ?? [];
}
