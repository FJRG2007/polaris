"use client";

/**
 * Emoji, GIFs and stickers, in one popover with tabs.
 *
 * Tabs rather than three buttons because they are three answers to one question -
 * "put something in this message that is not words" - and a composer with three
 * separate popovers beside each other is three things to aim at.
 *
 * Emoji come from a written list in the browser, so that tab works on an
 * instance with no internet and no configuration. GIFs and stickers come from
 * Tenor through the server, which is where the key lives; without one those two
 * tabs say so rather than sitting there empty and looking broken.
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
import { Loader2, Search, Smile } from "lucide-react";
import { EMOJI_GROUPS, searchEmoji } from "@/lib/chat/emoji";
import { searchTenorAction, tenorReadyAction } from "./actions";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

type Tab = "emoji" | "gif" | "sticker";

/** How long the field sits still before Tenor is asked. */
const SEARCH_AFTER = 300;

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
    onEmoji,
    onMedia
}: {
    disabled: boolean;
    onEmoji: (char: string) => void;
    /** A chosen GIF or sticker, by address. The caller sends it. */
    onMedia: (address: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<Tab>("emoji");
    const [query, setQuery] = useState("");
    const [tenorReady, setTenorReady] = useState<boolean | null>(null);
    const [results, setResults] = useState<readonly TenorResult[]>([]);
    const [searching, setSearching] = useState(false);
    const [at, setAt] = useState<Placement | null>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);

    const reposition = useCallback(() => {
        const button = trigger.current?.getBoundingClientRect();
        if (button) setAt(place(button));
    }, []);

    // Placed before the browser paints, so the panel is never seen at the corner
    // of the window on its way to the button.
    useLayoutEffect(() => {
        if (open) reposition();
    }, [open, reposition]);

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

    useEffect(() => {
        if (!open || tab === "emoji" || !tenorReady) return;
        setSearching(true);
        const timer = setTimeout(async () => {
            const answer = await searchTenorAction(query, tab === "sticker" ? "sticker" : "gif");
            setResults(answer.results);
            setSearching(false);
        }, SEARCH_AFTER);
        return () => clearTimeout(timer);
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
                    <div className="flex shrink-0 border-b border-border">
                        {(
                            [
                                ["emoji", "Emoji"],
                                ["gif", "GIFs"],
                                ["sticker", "Stickers"]
                            ] as const
                        ).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => {
                                    setTab(value);
                                    setResults([]);
                                }}
                                className={cn(
                                    "flex-1 px-3 py-2 text-xs font-medium transition-colors",
                                    tab === value
                                        ? "border-b-2 border-primary text-foreground"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <div className="relative shrink-0 border-b border-border px-2 py-1.5">
                        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <input
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={tab === "emoji" ? "Search emoji" : "Search Tenor"}
                            aria-label={tab === "emoji" ? "Search emoji" : "Search Tenor"}
                            className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs hover:border-border-strong focus:border-border-strong"
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
                                            onEmoji(char);
                                            setOpen(false);
                                        }}
                                    />
                                )
                            ) : (
                                EMOJI_GROUPS.map((group) => (
                                    <section key={group.name} className="mb-2">
                                        <h3 className="px-1 pb-1 text-[10px] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                                            {group.name}
                                        </h3>
                                        <Grid
                                            entries={group.emoji}
                                            onPick={(char) => {
                                                onEmoji(char);
                                                setOpen(false);
                                            }}
                                        />
                                    </section>
                                ))
                            )
                        ) : tenorReady === false ? (
                            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                                GIFs and stickers need a Tenor key. An administrator sets
                                POLARIS_TENOR_KEY.
                            </p>
                        ) : searching || tenorReady === null ? (
                            <p className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                                <Loader2 className="size-3.5 animate-spin" />
                                Looking
                            </p>
                        ) : results.length === 0 ? (
                            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                                Nothing came back for that.
                            </p>
                        ) : (
                            <ul className="grid grid-cols-2 gap-1">
                                {results.map((result) => (
                                    <li key={result.id}>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                onMedia(result.full);
                                                setOpen(false);
                                            }}
                                            className="block w-full overflow-hidden rounded-md ring-border transition-shadow hover:ring-2"
                                        >
                                            {/* eslint-disable-next-line @next/next/no-img-element -- a remote preview grid, no loader wanted */}
                                            <img
                                                src={result.preview}
                                                alt={result.description}
                                                loading="lazy"
                                                className="h-24 w-full bg-muted object-cover"
                                            />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>,
                document.body
            )}
        </>
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
