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
    /** What each of them is called now, which is not always what the page was
     *  rendered with - see `useProfileName`. */
    readonly names: ReadonlyMap<string, string>;
    /** What the reader calls them, for the few they have named - see
     *  `useContactName`. Kept apart from `names` because only the screen drawing
     *  somebody knows which of the two it is allowed to show. */
    readonly called: ReadonlyMap<string, string>;
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
    /**
     * What each of them is called, right now.
     *
     * Kept beside the decorations because it is the same kind of fact and it was
     * the one that did not move: somebody renamed themselves and every open
     * conversation went on saying the old name until the tab was reloaded. The
     * name a screen was rendered with stays the fallback - this only ever
     * replaces it once the server has answered.
     */
    const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
    /**
     * What this reader has called people, where they have named any.
     *
     * Beside the names rather than laid over them. A nickname is the reader's own
     * note and belongs where Polaris is showing them their own list of people; it
     * is not what somebody is called in a moderation queue, an administration
     * table or anywhere else a name stands for who somebody is - see
     * `contact-names`. One map that had already replaced the other would leave
     * the screen no way to tell the two apart.
     *
     * Only a full answer carries these. A revalidation is about what changed on
     * accounts, and a nickname does not change because its subject renamed
     * themselves.
     */
    const [called, setCalled] = useState<ReadonlyMap<string, string>>(new Map());
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

    /**
     * One request's worth of them, answering the server's clock.
     *
     * The clock is given back rather than stored here because a page can take
     * more than one request, and the next revalidation has to start from before
     * the first of them - see `ask`.
     */
    const askChunk = useCallback(async (ids: readonly string[], since: string | null) => {
        try {
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
            if (!response.ok) return null;
            const body = (await response.json()) as {
                people?: Record<string, unknown>;
                names?: Record<string, unknown>;
                nicknames?: Record<string, unknown>;
                cleared?: string[];
                at?: string;
            };
            const clock = typeof body.at === "string" ? body.at : null;
            const answered = Object.entries(body.people ?? {});
            const cleared = body.cleared ?? [];
            const named = Object.entries(body.names ?? {}).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""
            );
            if (named.length > 0) {
                setNames((current) => {
                    // Nothing actually different is nothing to re-render for,
                    // which is most revalidations.
                    if (named.every(([id, name]) => current.get(id) === name)) return current;
                    const next = new Map(current);
                    for (const [id, name] of named) next.set(id, name);
                    return next;
                });
            }
            // Only a full answer carries these, and it carries one for everybody
            // it was asked about - so an id missing from it is a nickname taken
            // off rather than one this answer had nothing to say about, and it
            // comes off here too. Without that, taking a nickname off left it on
            // screen until the tab was reloaded.
            if (body.nicknames) {
                const given = body.nicknames;
                setCalled((current) => {
                    const next = new Map(current);
                    let moved = false;
                    for (const id of ids) {
                        const told = given[id];
                        const wanted = typeof told === "string" && told !== "" ? told : null;
                        if ((next.get(id) ?? null) === wanted) continue;
                        moved = true;
                        if (wanted) next.set(id, wanted);
                        else next.delete(id);
                    }
                    return moved ? next : current;
                });
            }
            // The ordinary revalidation: nothing moved. Not setting state here is
            // what makes an idle tab free rather than a re-render every minute.
            if (answered.length === 0 && cleared.length === 0) return clock;
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
            return clock;
        } catch {
            // Offline, or a request that went away with the page. Faces draw
            // plain, which is what they draw for almost everybody anyway.
            return null;
        }
    }, []);

    /**
     * Ask about everybody in a list, in requests the server will answer.
     *
     * Cut at `MAX_PEOPLE_PER_STYLE_ASK`, because what is asked about is every
     * face drawn since the page loaded rather than the ones on screen now: an
     * afternoon in a directory or a busy chat passes that ceiling, and a request
     * over it is refused. There is nowhere to show that refusal, so the symptom
     * was silent and permanent - every name and every decoration stopped moving
     * for the rest of the session, including the nickname somebody had just set.
     */
    const ask = useCallback(
        async (ids: readonly string[], again: boolean) => {
            if (ids.length === 0) return;
            const since = again ? at.current : null;
            const clocks: string[] = [];
            for (let from = 0; from < ids.length; from += core.MAX_PEOPLE_PER_STYLE_ASK) {
                const clock = await askChunk(
                    ids.slice(from, from + core.MAX_PEOPLE_PER_STYLE_ASK),
                    since
                );
                if (clock) clocks.push(clock);
            }
            // The earliest of them. A later one would start the next revalidation
            // after an answer this one had already given, and whatever changed in
            // between would never be asked about again.
            const earliest = clocks.sort()[0];
            if (earliest) at.current = earliest;
        },
        [askChunk]
    );

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

    const store = useMemo<Store>(
        () => ({ people, names, called, watch, refresh }),
        [people, names, called, watch, refresh]
    );
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
/**
 * What somebody is called right now, or null until the server has said.
 *
 * Null rather than a guess, so the caller keeps the name the page was rendered
 * with until there is a better answer - a name that blinked to empty and back
 * would be worse than one that is a minute old.
 */
export function useProfileName(id: string | null | undefined): string | null {
    const store = useContext(Context);
    const watch = store?.watch;

    useEffect(() => {
        if (!id || !watch) return;
        watch(id);
    }, [id, watch]);

    if (!id || !store) return null;
    return store.names.get(id) ?? null;
}

/**
 * What this reader calls somebody, if they have given them a name.
 *
 * Separate from `useProfileName` on purpose: that is what the person is called,
 * this is a note the reader keeps about them. Most screens draw the note, and
 * the ones where a name is a claim about who somebody is - a moderation queue,
 * an administration table, a field that names an account - draw what they are
 * called. `PersonName` is where that choice is made; see `contact-names` for the
 * rule behind it.
 */
export function useContactName(id: string | null | undefined): string | null {
    const store = useContext(Context);
    const watch = store?.watch;

    useEffect(() => {
        if (!id || !watch) return;
        watch(id);
    }, [id, watch]);

    if (!id || !store) return null;
    return store.called.get(id) ?? null;
}

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
