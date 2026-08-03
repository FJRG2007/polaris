"use client";

/**
 * The address Polaris hands out, resolved once by the layout and read by every
 * client screen that puts a link in somebody's hands.
 *
 * It is deliberately not the hostname of the current tab: the LAN name the
 * installer writes (polaris.local) resolves on this network and nowhere else, so
 * a task link copied from it, or a tracker snippet built from it, is a link the
 * recipient cannot open. Server code already asks `appBaseUrl()` for this; the
 * provider is the same answer, in the browser.
 */

import { createContext, useContext, type ReactNode } from "react";

const AppUrlContext = createContext("");

export function AppUrlProvider({ baseUrl, children }: { baseUrl: string; children: ReactNode }) {
    return <AppUrlContext.Provider value={baseUrl}>{children}</AppUrlContext.Provider>;
}

/** The base URL to build a shareable link on, with no trailing slash. Outside a
 *  provider the current origin applies, so a component rendered on its own still
 *  copies an absolute link rather than a path. */
export function useAppUrl(): string {
    const base = useContext(AppUrlContext);
    const resolved = base || (typeof window === "undefined" ? "" : window.location.origin);
    return resolved.replace(/\/+$/, "");
}
