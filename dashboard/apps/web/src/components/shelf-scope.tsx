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

import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { PERSONAL_SHELF } from "@/lib/shelf";

const ShelfContext = createContext(PERSONAL_SHELF);

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

/**
 * State seeded by the server for the open shelf, and seeded again on a switch.
 *
 * What the badges above every screen hold. `useState(initial)` reads its seed
 * once, so the switch re-rendered the frame with the new shelf's count and the
 * badge went on showing the old one until something happened to recount it -
 * the number that says Mail has three waiting, over a shelf whose Mail has
 * none. The seed and the shelf arrive in the same render, so taking the seed
 * whenever the shelf moves is taking the right count, with no request.
 */
export function useShelfSeed<T>(initial: T): [T, Dispatch<SetStateAction<T>>] {
    const shelf = useShelfScope();
    const [value, setValue] = useState(initial);
    const [seededFor, setSeededFor] = useState(shelf);
    if (seededFor !== shelf) {
        // Set during render rather than in an effect, so the frame that shows
        // the new shelf never shows the old shelf's number beside it.
        setSeededFor(shelf);
        setValue(initial);
    }
    return [value, setValue];
}
