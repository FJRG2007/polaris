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
 */

import { cn } from "@polaris/ui";
import type { TenorResult } from "@/lib/chat/tenor";
import { Loader2, Search, Smile } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EMOJI_GROUPS, searchEmoji } from "@/lib/chat/emoji";
import { searchTenorAction, tenorReadyAction } from "./actions";

type Tab = "emoji" | "gif" | "sticker";

/** How long the field sits still before Tenor is asked. */
const SEARCH_AFTER = 300;

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
    const holder = useRef<HTMLDivElement>(null);

    // Closed by a press anywhere else, which is what a popover with no overlay
    // has instead of one. Escape as well, because a popover that only closes by
    // aiming at it is a popover that traps the keyboard.
    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            if (!holder.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
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

    return (
        <div ref={holder} className="relative">
            <button
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

            {open && (
                <div className="absolute bottom-full right-0 z-50 mb-2 w-80 overflow-hidden rounded-lg border border-border bg-elevated shadow-popover">
                    <div className="flex border-b border-border">
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

                    <div className="relative border-b border-border px-2 py-1.5">
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

                    <div className="max-h-64 overflow-y-auto p-2">
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
                </div>
            )}
        </div>
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
