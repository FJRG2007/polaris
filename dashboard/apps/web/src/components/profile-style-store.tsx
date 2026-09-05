"use client";

/**
 * What everybody on screen has chosen their profile to look like, asked once and
 * kept current.
 *
 * The same shape as the presence store, and for the same reason: a decoration
 * belongs beside a face, there are thirty faces on a busy screen, and threading
 * the answer through thirty view models is thirty places for it to be forgotten.
 * So the faces ask this, it collects the ids for a tick, and it comes back once.
 *
 * It used to keep that answer for the whole session, on the reasoning that an
 * appearance is a decision rather than a location. The reasoning was right and
 * the conclusion was wrong: a decision somebody makes is a decision everybody
 * else is looking at the old version of, for as long as their tab stays open.
 * You changed your decoration and nobody saw it until they reloaded.
 *
 * **How it stays current without becoming expensive.** Nothing is pushed to
 * everybody, and nothing is polled per account. Two things happen instead:
 *
 * - The browser revalidates *only the faces it is drawing* - a few dozen ids -
 *   and only asks what has changed since its last answer. The server replies
 *   with the people who are different and nothing else, so the ordinary answer
 *   is empty. The cost of this is proportional to people looking at a screen,
 *   never to how many accounts exist: a million accounts that changed nothing
 *   cost nothing.
 * - When a change happens near you it arrives at once, over the connection Chat
 *   already holds open on every screen - see `announceAppearance`. That frame
 *   carries an id and no appearance, and it only causes a request if that face
 *   is actually on this screen.
 *
 * So the push is for how it feels and the revalidation is for whether it is
 * right. A dropped frame, a sleeping laptop, a second server one day - all of
 * them heal on the next revalidation rather than leaving somebody wearing a ring
 * they took off a week ago.
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

/**
 * How often a visible tab asks what has changed.
 *
 * The floor under everything else, not the way changes normally arrive - those
 * come over the stream in the moment. This is the one that catches what the
 * stream could not: a frame dropped, a tab that was asleep, somebody whose
 * change happened in a part of Polaris this browser shares no room with. Slow
 * enough that a hundred idle tabs are not a workload, quick enough that nobody
 * sits looking at a stale face for long.
 *
 * A hidden tab does none of these. There is nobody looking at those faces, and
 * it asks the moment it is looked at again.
 */
const REVALIDATE_MS = 45_000;

interface Store {
    readonly people: ReadonlyMap<string, core.ProfileStyle>;
    readonly watch: (id: string) => void;
    readonly refresh: () => void;
}

const Context = createContext<Store | null>(null);

/**
 * Somebody's appearance changed, told to whatever is drawing them.
 *
 * A module-level channel rather than something threaded through the provider,
 * because the thing that hears it first is the Chat connection - which is
 * mounted above every screen and knows nothing about faces - and the thing that
 * acts on it is this store. Coupling those two through the component tree would
 * mean one of them had to be inside the other, and neither is.
 *
 * Carries an id and nothing else. What that person now looks like is pulled
 * through the same endpoint and the same session as every other face, so a frame
 * can never turn into being shown something a request would not have answered.
 */
const CHANGED = "polaris:appearance";

export function announceAppearance(ids: readonly string[]): void {
    if (typeof window === "undefined" || ids.length === 0) return;
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: [...ids] }));
}

export function ProfileStyleProvider({ children }: { children: ReactNode }) {
    const [people, setPeople] = useState<ReadonlyMap<string, core.ProfileStyle>>(new Map());
    /** Everybody drawn since this page loaded, which is what a revalidation asks
     *  about again. */
    const watched = useRef(new Set<string>());
    /** Ids that arrived since the last request went out. */
    const fresh = useRef(new Set<string>());
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** The server's clock at the last answer. Sent back as `since`, so the two
     *  never have to agree about the time. */
    const at = useRef<string | null>(null);
    /** What is on screen right now, readable from a callback that must not be
     *  rebuilt every time somebody's ring changes. */
    const drawn = useRef<ReadonlyMap<string, core.ProfileStyle>>(new Map());
    drawn.current = people;

    const ask = useCallback(async (ids: readonly string[], again: boolean) => {
        if (ids.length === 0) return;
        try {
            const since = again ? at.current : null;
            const response = await fetch("/api/profile/styles", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    ids,
                    ...(since
                        ? {
                              since,
                              // Only the decorated ones, which is the short list
                              // - it is what lets the server tell "went back to
                              // plain" from "unchanged". See `styleChangesSince`.
                              styled: ids.filter(
                                  (id) =>
                                      drawn.current.has(id) &&
                                      !core.styleIsPlain(
                                          drawn.current.get(id) ?? core.NO_PROFILE_STYLE
                                      )
                              )
                          }
                        : {})
                })
            });
            if (!response.ok) return;
            const body = (await response.json()) as {
                people?: Record<string, unknown>;
                cleared?: string[];
                at?: string;
            };
            if (typeof body.at === "string") at.current = body.at;
            const answered = Object.entries(body.people ?? {});
            const cleared = body.cleared ?? [];
            // The ordinary revalidation: nothing moved. Not setting state here is
            // what makes an idle tab free rather than a re-render every minute.
            if (answered.length === 0 && cleared.length === 0) return;
            setPeople((current) => {
                const next = new Map(current);
                // Checked here as well as on the server. This ends up in a
                // `style` attribute, and the one rule that makes that safe is
                // that nothing reaches it without having been recognised as
                // something Polaris shipped.
                for (const [id, style] of answered) {
                    next.set(id, core.readProfileStyle(style as Record<string, unknown>));
                }
                // Turned everything off. Set rather than deleted: deleting would
                // put them back into "not asked yet" and the face would ask
                // again on the next render, forever.
                for (const id of cleared) next.set(id, core.NO_PROFILE_STYLE);
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
                void ask(going, false);
            }, GATHER_MS);
        },
        [ask]
    );

    /** Ask about everybody on this screen again, saying what we already have. */
    const revalidate = useCallback(() => {
        if (!at.current) return;
        void ask([...watched.current], true);
    }, [ask]);

    const refresh = useCallback(() => {
        void ask([...watched.current], false);
    }, [ask]);

    /**
     * The three moments a screen can be behind: it was hidden and has come back,
     * it has been sitting there a while, and somebody near it just changed
     * something.
     */
    useEffect(() => {
        if (typeof window === "undefined") return;
        let beat: ReturnType<typeof setInterval> | null = null;

        function start(): void {
            if (beat) return;
            beat = setInterval(revalidate, REVALIDATE_MS);
        }
        function stop(): void {
            if (beat) clearInterval(beat);
            beat = null;
        }
        function onVisible(): void {
            if (document.visibilityState === "hidden") {
                stop();
                return;
            }
            // Coming back is the moment somebody is most likely to be looking at
            // something that moved while they were away.
            revalidate();
            start();
        }
        function onTold(event: Event): void {
            const ids = (event as CustomEvent<string[]>).detail ?? [];
            // Only what is actually on this screen. A frame about somebody
            // nobody here is drawing costs one array filter and no request.
            const mine = ids.filter((id) => watched.current.has(id));
            if (mine.length > 0) void ask(mine, false);
        }

        if (document.visibilityState !== "hidden") start();
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", revalidate);
        window.addEventListener(CHANGED, onTold);
        return () => {
            stop();
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("focus", revalidate);
            window.removeEventListener(CHANGED, onTold);
        };
    }, [ask, revalidate]);

    const store = useMemo<Store>(() => ({ people, watch, refresh }), [people, watch, refresh]);
    return <Context.Provider value={store}>{children}</Context.Provider>;
}

/**
 * Ask again, now.
 *
 * For the one case the revalidation is too slow for: somebody has just changed
 * their own appearance, and every face of theirs on the screen behind the panel
 * is still wearing the old one. Everybody else's browser hears about it over the
 * stream; this is the one browser that already knows.
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
