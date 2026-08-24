"use client";

/**
 * Emoji, GIFs and stickers, in one popover with tabs.
 *
 * Tabs rather than three buttons because they are three answers to one question -
 * "put something in this message that is not words" - and a composer with three
 * separate popovers beside each other is three things to aim at.
 *
 * Emoji come from a written list in the browser, so that tab works on an
 * instance with no internet and no configuration. Searching for GIFs and
 * stickers needs a service an administrator connects, and the key for it stays
 * on the server. Where none is connected those two tabs still do something: they
 * take the address of a picture, which is how a GIF is sent anywhere that has no
 * search, rather than sitting there empty and looking broken.
 *
 * Choosing an emoji types it into the message. Choosing a GIF sends it as its
 * own message, the way every chat client does - a GIF is the message.
 *
 * The panel is drawn into the body rather than beside the button. It is 20rem
 * wide and the button sits at the left edge of a composer with a conversation
 * list to its left, so a panel positioned inside that column has nowhere to go:
 * it either runs under the list or is clipped by the scroll area it is in.
 * Detaching it from the layout and placing it against the viewport is what makes
 * "it fits" a property of the screen rather than of the column.
 */

import { cn } from "@polaris/ui";
import { createPortal } from "react-dom";
import type { TenorResult } from "@/lib/chat/tenor";
import { Loader2, Search, Smile, Star } from "lucide-react";
import { EMOJI_GROUPS, searchEmoji } from "@/lib/chat/emoji";
import type { SavedMediaView } from "@/lib/chat/saved-media";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    recentEmoji,
    recentMedia,
    rememberEmoji,
    rememberMedia,
    type RecentMedia
} from "./recents";
import {
    listSavedMediaAction,
    saveMediaAction,
    savedSourcesAction,
    searchTenorAction,
    tenorReadyAction,
    unsaveMediaAction
} from "./actions";

type Tab = "emoji" | "saved" | "gif" | "sticker";

/** How long the field sits still before Tenor is asked. */
const SEARCH_AFTER = 300;

/**
 * What the search has already answered, for as long as this page is open.
 *
 * Outside the component on purpose: the picker is unmounted every time it is
 * closed, and without this the GIF tab was a spinner and a fresh request every
 * single time somebody opened it - for the same featured list they had just
 * been looking at.
 *
 * The server keeps the same answers for everybody (see `searchTenor`); this is
 * the half that also removes the round trip, so switching to the tab paints
 * rather than loads.
 */
const answers = new Map<string, readonly TenorResult[]>();

/** Asked once per page, when the picker is first opened: the featured list is
 *  what the GIF tab shows before anything is typed, and fetching it while
 *  somebody is still looking at the emoji is what makes that tab instant. Only
 *  on a deliberate open, never on a schedule - a picker nobody touches costs
 *  the instance nothing. */
let warmed = false;

/** Questions already on their way, so opening the tab that is being warmed does
 *  not ask the same thing a second time. */
const asking = new Map<string, Promise<readonly TenorResult[]>>();

function answerKey(tab: Tab, query: string): string {
    return `${tab}:${query.trim().toLowerCase()}`;
}

/**
 * One search, asked at most once.
 *
 * Every route to the grid goes through here - the warm-up, the tab, the typing -
 * so a question is answered from what is known, joined to one already in flight,
 * or asked. Nothing came back is not remembered: that is usually the service
 * being slow, and keeping it would leave the tab empty until somebody typed.
 *
 * A question that fails is forgotten for the same reason, and the failure is
 * answered with an empty list rather than left to reject. A rejected promise
 * kept in the map would be handed to every later press, so one bad moment would
 * break the tab for as long as the page stayed open - and nobody is waiting on
 * the warm-up, so its rejection would have nowhere to go.
 */
async function askFor(kind: "gif" | "sticker", query: string): Promise<readonly TenorResult[]> {
    const key = answerKey(kind, query);
    const known = answers.get(key);
    if (known) return known;

    const already = asking.get(key);
    if (already) return already;

    const question = searchTenorAction(query, kind)
        .then((answer) => {
            if (answer.results.length > 0) answers.set(key, answer.results);
            return answer.results as readonly TenorResult[];
        })
        .catch(() => [] as readonly TenorResult[])
        .finally(() => asking.delete(key));
    asking.set(key, question);
    return question;
}

/** The panel's width, the tallest it grows to on a roomy window, and the least
 *  height worth opening upward into. */
const PANEL_WIDTH = 320;
const MOST_HEIGHT = 400;
const LEAST_HEIGHT = 220;

/** How far the panel keeps off the edge of the window and off its button. */
const EDGE_GAP = 8;

/** Where the panel goes. */
interface Placement {
    readonly left: number;
    /** One edge is pinned and the other is left free, so the panel does not have
     *  to be measured to be placed: opening upward pins the bottom to the top of
     *  the button, which is right whatever height the panel turns out to be. */
    readonly top?: number;
    readonly bottom?: number;
    readonly maxHeight: number;
}

/**
 * Above its button if there is room for a usable panel there, below if there is
 * not, and never past either side of the window.
 *
 * The composer is at the bottom of the screen, so above is almost always the
 * answer; below is what happens on a short window, and it is better than a panel
 * that runs off the top with its search field out of reach.
 */
function place(button: DOMRect): Placement {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const left = Math.max(EDGE_GAP, Math.min(button.left, width - PANEL_WIDTH - EDGE_GAP));
    const roomAbove = button.top - EDGE_GAP * 2;
    const roomBelow = height - button.bottom - EDGE_GAP * 2;
    if (roomAbove >= LEAST_HEIGHT || roomAbove >= roomBelow) {
        return {
            left,
            bottom: height - button.top + EDGE_GAP,
            maxHeight: Math.min(roomAbove, MOST_HEIGHT)
        };
    }
    return { left, top: button.bottom + EDGE_GAP, maxHeight: Math.min(roomBelow, MOST_HEIGHT) };
}

export function EmojiPicker({
    disabled,
    media = true,
    onEmoji,
    onMedia,
    onSaved
}: {
    disabled: boolean;
    /**
     * Whether there is anything here but emoji.
     *
     * Off inside a call. The GIF search and the kept pictures both belong to an
     * account - one is looked up as this instance and the other is somebody's
     * own library - and half a call has no account at all, so the tabs would be
     * three ways of finding out you cannot use them.
     */
    media?: boolean;
    onEmoji: (char: string) => void;
    /** A chosen GIF or sticker, by address. The caller sends it. */
    onMedia: (address: string) => void;
    /** One the reader kept, by its id. Sent through its own path, since a stored
     *  one is copied rather than fetched back off this Polaris. */
    onSaved: (savedId: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<Tab>("emoji");
    const [query, setQuery] = useState("");
    const [tenorReady, setTenorReady] = useState<boolean | null>(null);
    const [results, setResults] = useState<readonly TenorResult[]>([]);
    const [saved, setSaved] = useState<readonly SavedMediaView[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [at, setAt] = useState<Placement | null>(null);
    // Read when the panel opens rather than on every render: it lives in local
    // storage, and the answer only changes because of a press inside here.
    const [recent, setRecent] = useState<{ emoji: string[]; media: RecentMedia[] }>({
        emoji: [],
        media: []
    });
    // Which of the pictures on screen this reader has kept, so every tile can
    // draw its star without one question per tile.
    const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);

    /** Ask about a screenful at once, and answer for exactly what was asked -
     *  anything that comes back unmentioned is not kept. */
    const learnKept = useCallback(async (sources: readonly string[]) => {
        const asked = [...new Set(sources.filter(Boolean))];
        if (asked.length === 0) return;
        const answer = await savedSourcesAction(asked).catch(() => null);
        if (!answer) return;
        setKept((current) => {
            const next = new Set(current);
            for (const source of asked) next.delete(source);
            for (const source of answer.sources) next.add(source);
            return next;
        });
    }, []);

    /**
     * Keep a picture, or stop keeping it.
     *
     * Optimistic, and put back if the server disagrees: the star is a bookmark,
     * and a bookmark that waits for a round trip before it lights up reads as a
     * press that did not land.
     */
    const toggleKeep = useCallback(async (source: string, name: string, keep: boolean) => {
        const set = (on: boolean) =>
            setKept((current) => {
                const next = new Set(current);
                if (on) next.add(source);
                else next.delete(source);
                return next;
            });

        set(keep);
        const result = keep ? await saveMediaAction(source, name) : await unsaveMediaAction(source);
        if (result.error) {
            set(!keep);
            return;
        }
        // The kept tab is now out of date whichever way this went. Dropped rather
        // than patched, so it is asked for again the next time it is opened - and
        // straight away if that is the tab somebody is standing in.
        setSaved(null);
    }, []);

    const reposition = useCallback(() => {
        const button = trigger.current?.getBoundingClientRect();
        if (button) setAt(place(button));
    }, []);

    // Placed before the browser paints, so the panel is never seen at the corner
    // of the window on its way to the button.
    useLayoutEffect(() => {
        if (open) reposition();
    }, [open, reposition]);

    useEffect(() => {
        if (!open) return;
        setRecent({ emoji: recentEmoji(), media: recentMedia() });
    }, [open]);

    // The panel is not in the flow, so nothing moves it when the window does.
    useEffect(() => {
        if (!open) return;
        window.addEventListener("resize", reposition);
        // Captured, because the thing that scrolls is the message list rather
        // than the window, and a scroll event does not bubble.
        window.addEventListener("scroll", reposition, true);
        return () => {
            window.removeEventListener("resize", reposition);
            window.removeEventListener("scroll", reposition, true);
        };
    }, [open, reposition]);

    // Closed by a press anywhere else, which is what a popover with no overlay
    // has instead of one. Escape as well, because a popover that only closes by
    // aiming at it is a popover that traps the keyboard. Both the button and the
    // panel count as "inside", since the panel is no longer within the button's
    // element after being drawn into the body.
    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
            setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setOpen(false);
                trigger.current?.focus();
            }
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    useEffect(() => {
        if (!open || tenorReady !== null) return;
        void tenorReadyAction().then(setTenorReady);
    }, [open, tenorReady]);

    // Asked once the tab is opened rather than with the picker: most times this
    // is opened it is to pick an emoji, and a list nobody looked at is a query
    // nobody needed.
    useEffect(() => {
        if (!open || tab !== "saved" || saved !== null) return;
        void listSavedMediaAction().then((answer) => {
            setSaved(answer.saved);
            // Everything in here is kept by definition, so the stars are known
            // without asking a second question about them.
            setKept((current) => new Set([...current, ...answer.saved.map((one) => one.source)]));
        });
    }, [open, tab, saved]);

    // The stars for whatever is on screen. One question per screenful of
    // pictures, asked when the pictures change rather than when a star is drawn.
    useEffect(() => {
        if (!open) return;
        void learnKept([
            ...results.map((result) => result.full),
            ...recent.media.map((entry) => entry.full)
        ]);
    }, [open, results, recent.media, learnKept]);

    // The featured list, fetched while the emoji tab is still the one on screen.
    // Nothing is drawn from this directly - it fills the same store the tab
    // reads, so opening GIFs finds it already there.
    useEffect(() => {
        if (!open || !tenorReady || warmed) return;
        warmed = true;
        void askFor("gif", "");
    }, [open, tenorReady]);

    useEffect(() => {
        if (!open || tab === "emoji" || tab === "saved" || !tenorReady) return;

        const known = answers.get(answerKey(tab, query));
        if (known) {
            setResults(known);
            setSearching(false);
            return;
        }

        // Only now: a tab that has an answer already never shows a spinner, and
        // a tab that does not is honest about waiting.
        setSearching(true);
        let live = true;
        const timer = setTimeout(async () => {
            const results = await askFor(tab, query);
            if (!live) return;
            setResults(results);
            setSearching(false);
        }, SEARCH_AFTER);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [open, tab, query, tenorReady]);

    const found = useMemo(() => searchEmoji(query), [query]);

    const button = (
        <button
            ref={trigger}
            type="button"
            disabled={disabled}
            aria-label="Emoji, GIFs and stickers"
            title="Emoji, GIFs and stickers"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
            <Smile className="size-4" />
        </button>
    );

    if (!open || at === null || typeof document === "undefined") return button;

    return (
        <>
            {button}
            {createPortal(
                <div
                    ref={panel}
                    role="dialog"
                    aria-label="Emoji, GIFs and stickers"
                    style={{
                        left: at.left,
                        top: at.top,
                        bottom: at.bottom,
                        width: PANEL_WIDTH,
                        maxHeight: at.maxHeight
                    }}
                    className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border-strong bg-elevated shadow-popover"
                >
                    <div className={cn("flex shrink-0 border-b border-border", !media && "hidden")}>
                        {(
                            [
                                ["emoji", "Emoji"],
                                ["saved", "Kept"],
                                ["gif", "GIFs"],
                                ["sticker", "Stickers"]
                            ] as const
                        ).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => {
                                    setTab(value);
                                    // Whatever is already known for the tab
                                    // being opened, so switching paints rather
                                    // than blanks - and never the other tab's
                                    // results while this one is still asking.
                                    setResults(answers.get(answerKey(value, query)) ?? []);
                                }}
                                className={cn(
                                    "flex-1 px-2 py-2 text-xs font-medium transition-colors",
                                    tab === value
                                        ? "border-b-2 border-primary text-foreground"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <div
                        className={cn(
                            "relative shrink-0 border-b border-border px-2 py-1.5",
                            // Nothing to search: what is kept is a short list
                            // somebody assembled themselves.
                            tab === "saved" && "hidden"
                        )}
                    >
                        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <input
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={
                                tab === "emoji"
                                    ? "Search emoji"
                                    : tab === "sticker"
                                      ? "Search stickers"
                                      : "Search GIFs"
                            }
                            aria-label={
                                tab === "emoji"
                                    ? "Search emoji"
                                    : tab === "sticker"
                                      ? "Search stickers"
                                      : "Search GIFs"
                            }
                            className="h-7 w-full rounded-md border border-border bg-field pl-7 pr-2 text-xs hover:border-border-strong focus:border-border-strong"
                        />
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto p-2">
                        {tab === "emoji" ? (
                            query.trim() ? (
                                found.length === 0 ? (
                                    <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                                        No emoji matches that.
                                    </p>
                                ) : (
                                    <Grid
                                        entries={found}
                                        onPick={(char) => {
                                            rememberEmoji(char);
                                            onEmoji(char);
                                            setOpen(false);
                                        }}
                                    />
                                )
                            ) : (
                                <>
                                    {/* First, because nine emoji out of two
                                        thousand are almost everything anybody
                                        sends - and they are not the same nine
                                        for any two people. */}
                                    {recent.emoji.length > 0 && (
                                        <section className="mb-2">
                                            <h3 className="px-1 pb-1 text-[10px] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                                                Recent
                                            </h3>
                                            <Grid
                                                entries={recent.emoji.map((char) => ({
                                                    char,
                                                    words: ""
                                                }))}
                                                onPick={(char) => {
                                                    rememberEmoji(char);
                                                    onEmoji(char);
                                                    setOpen(false);
                                                }}
                                            />
                                        </section>
                                    )}
                                    {EMOJI_GROUPS.map((group) => (
                                        <section key={group.name} className="mb-2">
                                            <h3 className="px-1 pb-1 text-[10px] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                                                {group.name}
                                            </h3>
                                            <Grid
                                                entries={group.emoji}
                                                onPick={(char) => {
                                                    rememberEmoji(char);
                                                    onEmoji(char);
                                                    setOpen(false);
                                                }}
                                            />
                                        </section>
                                    ))}
                                </>
                            )
                        ) : tab === "saved" ? (
                            saved === null ? (
                                <p className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                                    <Loader2 className="size-3.5 animate-spin" />
                                    Looking
                                </p>
                            ) : saved.length === 0 ? (
                                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                                    Nothing kept yet. The star in the corner of any picture puts it
                                    here - in a message, or in the GIFs beside this.
                                </p>
                            ) : (
                                <ul className="grid grid-cols-2 gap-1">
                                    {saved.map((entry) => (
                                        <Tile
                                            key={entry.id}
                                            preview={entry.src}
                                            description={entry.name}
                                            kept={kept.has(entry.source)}
                                            onPick={() => {
                                                onSaved(entry.id);
                                                setOpen(false);
                                            }}
                                            onKeep={(keep) =>
                                                void toggleKeep(entry.source, entry.name, keep)
                                            }
                                        />
                                    ))}
                                </ul>
                            )
                        ) : tenorReady === false ? (
                            <div className="flex flex-col gap-3 px-2 py-4">
                                <p className="text-center text-xs text-muted-foreground">
                                    Searching for GIFs and stickers is switched off here. An
                                    administrator can turn it on.
                                </p>
                                <ByLink
                                    onSend={(address) => {
                                        onMedia(address);
                                        setOpen(false);
                                    }}
                                />
                            </div>
                        ) : searching || tenorReady === null ? (
                            <p className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                                <Loader2 className="size-3.5 animate-spin" />
                                Looking
                            </p>
                        ) : !query.trim() && recent.media.length > 0 ? (
                            // Before anything has been typed, the ones already
                            // sent from this browser. Somebody opening the GIF
                            // tab is usually reaching for the same one again.
                            <>
                                <h3 className="px-1 pb-1 text-[10px] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                                    Recent
                                </h3>
                                <MediaGrid
                                    entries={recent.media}
                                    kept={kept}
                                    onKeep={toggleKeep}
                                    onPick={(media) => {
                                        rememberMedia(media);
                                        onMedia(media.full);
                                        setOpen(false);
                                    }}
                                />
                                {results.length > 0 && (
                                    <h3 className="px-1 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                                        Trending
                                    </h3>
                                )}
                                <MediaGrid
                                    entries={results.map((result) => ({
                                        preview: result.preview,
                                        full: result.full,
                                        description: result.description
                                    }))}
                                    kept={kept}
                                    onKeep={toggleKeep}
                                    onPick={(media) => {
                                        rememberMedia(media);
                                        onMedia(media.full);
                                        setOpen(false);
                                    }}
                                />
                            </>
                        ) : results.length === 0 ? (
                            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                                Nothing came back for that.
                            </p>
                        ) : (
                            <MediaGrid
                                entries={results.map((result) => ({
                                    preview: result.preview,
                                    full: result.full,
                                    description: result.description
                                }))}
                                kept={kept}
                                onKeep={toggleKeep}
                                onPick={(media) => {
                                    rememberMedia(media);
                                    onMedia(media.full);
                                    setOpen(false);
                                }}
                            />
                        )}
                    </div>
                </div>,
                document.body
            )}
        </>
    );
}

/**
 * Sending a picture by its address.
 *
 * What the picker offers when the search is not switched on, and it is not a
 * consolation prize: every GIF anybody sends comes from a page they found it on,
 * and pasting that address is how it gets here without an account with anybody.
 * The picture is fetched once by the server and stored like any other
 * attachment, so the conversation never asks the other site for it.
 */
function ByLink({ onSend }: { onSend: (address: string) => void }) {
    const [address, setAddress] = useState("");
    const usable = /^https?:\/\/\S+$/i.test(address.trim());

    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                if (usable) onSend(address.trim());
            }}
            className="flex flex-col gap-1.5"
        >
            <label htmlFor="picker-link" className="text-xs text-muted-foreground">
                Send a picture or GIF by its address
            </label>
            <span className="flex gap-1.5">
                <input
                    id="picker-link"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder="https://"
                    className="h-7 min-w-0 flex-1 rounded-md border border-border bg-field px-2 text-xs hover:border-border-strong focus:border-border-strong"
                />
                <button
                    type="submit"
                    disabled={!usable}
                    className="rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-40"
                >
                    Send
                </button>
            </span>
        </form>
    );
}

/**
 * A grid of GIFs, drawn the same way whether they came back from a search, out of
 * what this browser sent last, or out of what somebody kept.
 *
 * Its own component because there are four of those places now, and four copies
 * of a grid is four places for the one that is wrong to hide.
 */
function MediaGrid({
    entries,
    kept,
    onPick,
    onKeep
}: {
    entries: readonly RecentMedia[];
    kept: ReadonlySet<string>;
    onPick: (media: RecentMedia) => void;
    onKeep: (source: string, name: string, keep: boolean) => void;
}) {
    if (entries.length === 0) return null;
    return (
        <ul className="grid grid-cols-2 gap-1 pb-1">
            {entries.map((entry) => (
                <Tile
                    key={entry.full}
                    preview={entry.preview}
                    description={entry.description}
                    kept={kept.has(entry.full)}
                    onPick={() => onPick(entry)}
                    onKeep={(keep) => onKeep(entry.full, entry.description, keep)}
                />
            ))}
        </ul>
    );
}

/**
 * One picture in a grid, with the star in its corner.
 *
 * The star is the same gesture as the one on a picture in a message and it does
 * the same thing, which is the point: somebody who found a GIF in the search
 * should not have to send it first and then keep it from the conversation. It
 * appears on hover and on focus, and stays lit on the ones already kept.
 *
 * Pressing it is the whole gesture - the press does not also send the picture,
 * which is what "keep this for later" has to mean.
 */
function Tile({
    preview,
    description,
    kept,
    onPick,
    onKeep
}: {
    preview: string;
    description: string;
    kept: boolean;
    onPick: () => void;
    onKeep: (keep: boolean) => void;
}) {
    return (
        <li className="group/pic relative">
            <button
                type="button"
                title={description || "Send this"}
                onClick={onPick}
                className="block w-full overflow-hidden rounded-md ring-border transition-shadow hover:ring-2"
            >
                {/* eslint-disable-next-line @next/next/no-img-element -- a remote preview grid, no loader wanted */}
                <img
                    src={preview}
                    alt={description}
                    loading="lazy"
                    className="h-24 w-full bg-muted object-cover"
                />
            </button>
            <button
                type="button"
                aria-pressed={kept}
                aria-label={kept ? "Stop keeping this picture" : "Keep this picture"}
                title={kept ? "Kept. It is in your picker." : "Keep this"}
                onClick={(event) => {
                    // The tile under it sends. Keeping is not the first half of
                    // sending.
                    event.preventDefault();
                    event.stopPropagation();
                    onKeep(!kept);
                }}
                className={cn(
                    "absolute right-1 top-1 rounded-md border border-border bg-background/80 p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/pic:opacity-100",
                    kept && "text-primary opacity-100"
                )}
            >
                <Star className={cn("size-3.5", kept && "fill-current")} />
            </button>
        </li>
    );
}

function Grid({
    entries,
    onPick
}: {
    entries: readonly { char: string; words: string }[];
    onPick: (char: string) => void;
}) {
    return (
        <ul className="grid grid-cols-8 gap-0.5">
            {entries.map((entry) => (
                <li key={entry.char}>
                    <button
                        type="button"
                        title={entry.words}
                        aria-label={entry.words}
                        onClick={() => onPick(entry.char)}
                        className="flex size-8 items-center justify-center rounded text-lg transition-colors hover:bg-muted"
                    >
                        {entry.char}
                    </button>
                </li>
            ))}
        </ul>
    );
}
