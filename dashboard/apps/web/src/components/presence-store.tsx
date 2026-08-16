"use client";

/**
 * Where everybody on screen is, asked once.
 *
 * Every face in Polaris wants two facts - is this person here, are they on a
 * call I could join - and there are thirty faces on a busy screen. Thirty
 * requests is not an option, and threading the answer through thirty view models
 * is thirty places for it to be forgotten. So the faces ask this, it collects
 * the ids for a tick, and it comes back once.
 *
 * What it holds is deliberately short-lived. Presence that is a minute old is
 * worse than none: a green dot beside somebody who left is the one thing this
 * feature must not do. So an answer is refreshed on an interval while anything
 * is watching, and the whole thing is dropped when nothing is.
 *
 * Absent from the map means "not asked yet", which is what makes the first paint
 * quiet: a face draws with no dot rather than with a grey one that turns green,
 * because a dot that changes colour on arrival reads as somebody's status
 * changing.
 */

import type { Presence } from "@polaris/core";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode
} from "react";

export type { Presence };

export interface PresenceOf {
    readonly status: Presence;
    /** The conversation of a call they are in and the reader could join. */
    readonly inCall: string | null;
}

/** How long before what is on screen is asked about again. */
const REFRESH_MS = 45_000;

/** How long ids are collected before the request goes. One tick of a screen
 *  mounting, so a list of thirty faces is one request rather than thirty. */
const GATHER_MS = 60;

interface Store {
    readonly people: ReadonlyMap<string, PresenceOf>;
    readonly watch: (id: string) => void;
}

const Context = createContext<Store | null>(null);

export function PresenceProvider({ children }: { children: ReactNode }) {
    const [people, setPeople] = useState<ReadonlyMap<string, PresenceOf>>(new Map());
    /** Everybody currently drawn, which is what gets refreshed. */
    const watched = useRef(new Set<string>());
    /** Ids that arrived since the last request went out. */
    const fresh = useRef(new Set<string>());
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const ask = useCallback(async (ids: readonly string[]) => {
        if (ids.length === 0) return;
        try {
            const response = await fetch("/api/presence", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ids })
            });
            if (!response.ok) return;
            const body = (await response.json()) as { people?: Record<string, PresenceOf> };
            const answered = Object.entries(body.people ?? {});
            if (answered.length === 0) return;
            setPeople((current) => {
                const next = new Map(current);
                for (const [id, where] of answered) next.set(id, where);
                return next;
            });
        } catch {
            // Offline, or a request that went away with the page. The dots keep
            // whatever they had, which is the right way to be wrong.
        }
    }, []);

    const watch = useCallback(
        (id: string) => {
            if (watched.current.has(id)) return;
            watched.current.add(id);
            fresh.current.add(id);
            if (timer.current) return;
            timer.current = setTimeout(() => {
                timer.current = null;
                const going = [...fresh.current];
                fresh.current.clear();
                void ask(going);
            }, GATHER_MS);
        },
        [ask]
    );

    // Everything on screen, again, while anything is on screen. A dot that was
    // right when the page loaded and never moved is worse than no dot.
    useEffect(() => {
        const beat = setInterval(() => {
            void ask([...watched.current]);
        }, REFRESH_MS);
        return () => clearInterval(beat);
    }, [ask]);

    const store = useMemo<Store>(() => ({ people, watch }), [people, watch]);
    return <Context.Provider value={store}>{children}</Context.Provider>;
}

/**
 * Where one person is, or null until it is known.
 *
 * Safe outside the provider: a screen with no presence around it - a sign-in
 * page, a public link - draws no dots rather than throwing.
 */
export function usePresence(id: string | null | undefined): PresenceOf | null {
    const store = useContext(Context);
    const watch = store?.watch;

    useEffect(() => {
        if (!id || !watch) return;
        watch(id);
    }, [id, watch]);

    if (!id || !store) return null;
    return store.people.get(id) ?? null;
}
