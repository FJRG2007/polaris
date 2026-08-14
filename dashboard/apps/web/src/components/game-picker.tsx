"use client";

/**
 * Which game a server plays.
 *
 * A picker rather than a row of cards, because the list is going to grow: two
 * games fit across a dialog and five do not, and a form whose first question
 * silently reflows into three rows as games are added is a form that has to be
 * redesigned every time one is. So it reads like every other field - a control
 * that says what is chosen, and a list under it - with a search box that earns
 * its place the moment there is more to scroll than to see.
 *
 * Each game is shown by its own logo. A name in a list is read; a logo is
 * recognised, and the person creating a Minecraft server knows exactly what the
 * grass block means before they have read anything.
 *
 * Deliberately not a native select or a Radix menu: both have their own
 * typeahead, which fights a search box for the same keystrokes.
 */

import { Input, cn } from "@polaris/ui";
import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GameDefinition, GameId } from "@/lib/apps/games-catalog";

/** Past this many, scanning the list stops being instant and the search box is
 *  what somebody reaches for. Below it the box is one more thing on screen that
 *  nobody would ever type into. */
const SEARCHABLE_FROM = 4;

/** Whether a game matches what somebody typed. Its name, what it is, and what it
 *  takes to run one - so "dinosaur" and "bedrock" both find something. */
function matches(game: GameDefinition, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return true;
    return [game.name, game.summary, game.demands, game.id].some((value) => value.toLowerCase().includes(needle));
}

/** A game's own mark, from its publisher. Decoration beside a name that is already
 *  written out, so it is hidden from a screen reader rather than described twice. */
export function GameLogo({ game, className }: { game: GameDefinition; className?: string }) {
    return <img src={game.logo} alt="" aria-hidden className={cn("shrink-0 object-contain", className)} />;
}

export function GamePicker({
    games,
    value,
    onChange,
    disabled
}: {
    /** The games this Polaris can create a server of, in catalog order. */
    games: readonly GameDefinition[];
    value: GameId;
    onChange: (game: GameId) => void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const root = useRef<HTMLDivElement>(null);
    const selected = games.find((game) => game.id === value) ?? games[0] ?? null;
    const searchable = games.length >= SEARCHABLE_FROM;
    const shown = useMemo(() => games.filter((game) => matches(game, query)), [games, query]);

    // Closing on a click elsewhere and on Escape, which is what every other popup
    // on the page does and what a keyboard is going to try first.
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: MouseEvent): void => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    function choose(game: GameDefinition): void {
        onChange(game.id);
        setOpen(false);
        setQuery("");
    }

    return (
        <div ref={root} className="relative flex flex-col gap-1">
            <button
                type="button"
                disabled={disabled}
                onClick={() => setOpen((value) => !value)}
                aria-haspopup="listbox"
                aria-expanded={open}
                className={cn(
                    "flex h-14 w-full items-center gap-3 rounded-md border border-border bg-surface px-3 text-left text-sm transition-colors",
                    "hover:border-border ",
                    "disabled:cursor-not-allowed disabled:opacity-50"
                )}
            >
                {selected ? (
                    <>
                        <GameLogo game={selected} className="size-8" />
                        <span className="flex min-w-0 flex-col">
                            <span className="truncate font-medium" title={selected.name}>{selected.name}</span>
                            <span className="truncate text-xs text-muted-foreground" title={selected.summary}>{selected.summary}</span>
                        </span>
                    </>
                ) : (
                    <span className="text-muted-foreground">No game is available</span>
                )}
                <ChevronDown
                    className={cn(
                        "ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-150",
                        open && "rotate-180"
                    )}
                />
            </button>

            {open && (
                <div className="absolute left-0 right-0 top-[calc(100%+0.25rem)] z-50 flex max-h-80 flex-col overflow-hidden rounded-lg border border-border-strong bg-elevated shadow-popover">
                    {searchable && (
                        <div className="relative border-b border-border/60 p-2">
                            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                autoFocus
                                className="h-8 pl-8"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="Search games"
                                aria-label="Search games"
                            />
                        </div>
                    )}
                    <div role="listbox" className="flex flex-col gap-0.5 overflow-y-auto p-1">
                        {shown.length === 0 ? (
                            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                                No game here matches that.
                            </p>
                        ) : (
                            shown.map((game) => (
                                <button
                                    key={game.id}
                                    type="button"
                                    role="option"
                                    aria-selected={game.id === value}
                                    onClick={() => choose(game)}
                                    className={cn(
                                        "flex w-full items-center gap-3 rounded-md p-2 text-left text-sm transition-colors",
                                        game.id === value ? "bg-muted" : "hover:bg-muted/60"
                                    )}
                                >
                                    <GameLogo game={game} className="size-8" />
                                    <span className="flex min-w-0 flex-col">
                                        <span className="truncate font-medium" title={game.name}>{game.name}</span>
                                        <span className="truncate text-xs text-muted-foreground" title={game.summary}>{game.summary}</span>
                                        {/* What a server of it actually costs. The
                                            two differ by an order of magnitude, and
                                            it is the one thing nobody finds out
                                            until the disk is full. */}
                                        <span className="truncate text-xs text-muted-foreground/80">
                                            {game.demands}
                                        </span>
                                    </span>
                                    {game.id === value && <Check className="ml-auto size-4 shrink-0 text-primary" />}
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
