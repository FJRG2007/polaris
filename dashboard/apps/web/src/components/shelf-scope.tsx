"use client";

/**
 * Which shelf the screens of this tab are drawing.
 *
 * The shelf switch writes a cookie, revalidates every layout and refreshes the
 * router, which is enough for anything the server renders. It is not enough for
 * the screens that fetch their own data - Mail's list, Office's documents,
 * anything built the way both of those are - because their fetch is a client
 * effect whose dependencies never mentioned the shelf. The server re-rendered,
 * the props came back identical, the effect did not re-run, and the personal
 * shelf's documents stayed on screen under an organization's name.
 *
 * Worse than stale: `useLiveRead` keeps the last answer under a key, so the two
 * shelves were writing to and reading from the same one. Switching back showed
 * the other shelf's rows instantly, from the cache, before any request went out.
 *
 * So the shelf is a value on the page, and everything that fetches depends on
 * it. It is the id rather than the name - "personal" or an organization's id -
 * because it is a key as much as a fact, and a name can be changed.
 */

import { createContext, useContext, type ReactNode } from "react";

const ShelfContext = createContext("personal");

export function ShelfScopeProvider({ shelf, children }: { shelf: string; children: ReactNode }) {
    return <ShelfContext.Provider value={shelf}>{children}</ShelfContext.Provider>;
}

/**
 * The shelf open right now: `personal`, or an organization's id.
 *
 * Put it in the dependencies of any fetch whose answer depends on which shelf is
 * open, and in the key of anything that keeps that answer. Outside a provider it
 * is the personal shelf, which keeps a component rendered on its own working.
 */
export function useShelfScope(): string {
    return useContext(ShelfContext);
}
