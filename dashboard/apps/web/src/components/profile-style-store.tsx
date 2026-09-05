"use client";

/**
 * What everybody on screen has chosen their profile to look like, asked once.
 *
 * The same shape as the presence store, and for the same reason: a decoration
 * belongs beside a face, there are thirty faces on a busy screen, and threading
 * the answer through thirty view models is thirty places for it to be forgotten.
 * So the faces ask this, it collects the ids for a tick, and it comes back once.
 *
 * Where it differs from presence is what it does afterwards. Presence has to be
 * refreshed because it goes stale in seconds; an appearance is a decision, so it
 * is asked for once and kept for the session. Somebody changing their own is the
 * one case that needs telling - their face is the one they are looking at - and
 * `useProfileStyleRefresh` is that case.
 *
 * Absent from the map means "not asked yet", which is what keeps the first paint
 * quiet: a face draws plain rather than drawing plain and then growing a ring,
 * which reads as something arriving late rather than as a decoration.
 */

import * as core from "@polaris/core";
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

/** How long ids are collected before the request goes. One tick of a screen
 *  mounting, so a list of thirty faces is one request rather than thirty. */
const GATHER_MS = 60;

interface Store {
    readonly people: ReadonlyMap<string, core.ProfileStyle>;
    readonly watch: (id: string) => void;
    readonly refresh: () => void;
}

const Context = createContext<Store | null>(null);

export function ProfileStyleProvider({ children }: { children: ReactNode }) {
    const [people, setPeople] = useState<ReadonlyMap<string, core.ProfileStyle>>(new Map());
    /** Everybody drawn since this page loaded, which is what a refresh asks
     *  about again. */
    const watched = useRef(new Set<string>());
    /** Ids that arrived since the last request went out. */
    const fresh = useRef(new Set<string>());
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const ask = useCallback(async (ids: readonly string[]) => {
        if (ids.length === 0) return;
        try {
            const response = await fetch("/api/profile/styles", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ids })
            });
            if (!response.ok) return;
            const body = (await response.json()) as { people?: Record<string, unknown> };
            const answered = Object.entries(body.people ?? {});
            if (answered.length === 0) return;
            setPeople((current) => {
                const next = new Map(current);
                // Checked here as well as on the server. This ends up in a
                // `style` attribute, and the one rule that makes that safe is
                // that nothing reaches it without having been recognised as
                // something Polaris shipped.
                for (const [id, style] of answered) {
                    next.set(id, core.readProfileStyle(style as Record<string, unknown>));
                }
                return next;
            });
        } catch {
            // Offline, or a request that went away with the page. Faces draw
            // plain, which is what they draw for almost everybody anyway.
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

    const refresh = useCallback(() => {
        void ask([...watched.current]);
    }, [ask]);

    const store = useMemo<Store>(() => ({ people, watch, refresh }), [people, watch, refresh]);
    return <Context.Provider value={store}>{children}</Context.Provider>;
}

/**
 * Ask again, now.
 *
 * For the one case a session-long cache is wrong for: somebody has just changed
 * their own appearance, and every face of theirs on the screen behind the panel
 * is still wearing the old one.
 *
 * A no-op outside the provider, so a screen with no faces on it can call it
 * without knowing whether there is a store above.
 */
export function useProfileStyleRefresh(): () => void {
    const store = useContext(Context);
    return store?.refresh ?? (() => undefined);
}

/**
 * One person's appearance, or null until it is known.
 *
 * Safe outside the provider: a public page, a sign-in screen, an email preview -
 * all draw plain faces rather than throwing.
 */
export function useProfileStyle(id: string | null | undefined): core.ProfileStyle | null {
    const store = useContext(Context);
    const watch = store?.watch;

    useEffect(() => {
        if (!id || !watch) return;
        watch(id);
    }, [id, watch]);

    if (!id || !store) return null;
    return store.people.get(id) ?? null;
}
