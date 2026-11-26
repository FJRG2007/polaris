"use client";

/**
 * Who the tabs of this browser are currently signed in as, for the client code
 * that shares one live connection between them.
 *
 * A connection is authorized when it opens and keeps serving that account until
 * it closes, so a tab left open on a previous account is still being fed that
 * account's stream. Keying what the tabs share on this id is what stops it
 * reaching the tab of whoever signed in after.
 */

import { createContext, useContext, type ReactNode } from "react";

const SessionScopeContext = createContext("");
const SessionNameContext = createContext("");

export function SessionScopeProvider({
    userId,
    name = "",
    children
}: {
    userId: string;
    /** The signed-in account's display name, for a screen that draws the
     *  viewer's own face (the voice widget preview) without asking for it. */
    name?: string;
    children: ReactNode;
}) {
    return (
        <SessionScopeContext.Provider value={userId}>
            <SessionNameContext.Provider value={name}>{children}</SessionNameContext.Provider>
        </SessionScopeContext.Provider>
    );
}

/** The signed-in account's id. Empty outside a provider, which keeps a component
 *  rendered on its own working - it simply shares nothing with other tabs. */
export function useSessionScope(): string {
    return useContext(SessionScopeContext);
}

/** The signed-in account as a face draws it, from what the page already holds;
 *  null outside a provider. */
export function useSessionViewer(): { id: string; name: string } | null {
    const id = useContext(SessionScopeContext);
    const name = useContext(SessionNameContext);
    return id ? { id, name } : null;
}
