"use client";

/**
 * A folder of photographs shown as photographs: square tiles under a heading
 * for each day, the way a photo library lays out its timeline.
 *
 * Technique: the day-sectioned square timeline of Nextcloud Photos and Immich's
 * square mode, virtualized by row - see `lib/drive-media.ts` for why the tiles
 * are square rather than Google Photos' justified rows.
 *
 * It owns only the layout. What a click, a double click, a right click or a
 * drag does is the listing's, handed in, so the photo view selects, opens,
 * shares and moves files exactly as the list and the grid do. The arrow keys are
 * the one thing it answers itself, because only it knows which tile is above
 * which; it reports where the cursor lands and the listing does the selecting.
 */

import { cn } from "@polaris/ui";
import { Play } from "lucide-react";
import type { DriveEntry } from "./types";
import { EntryThumbnail, type ThumbnailUrls } from "./entry-thumbnail";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLocale } from "@/components/i18n/i18n-provider";
import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from "react";
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { mediaKindOf, photoNeighbour, photoRows, rowOfIndex } from "@/lib/drive-media";

/** The tile a row aims for. Columns are however many of these fit. */
const TILE_TARGET = 168;
/** Never fewer than this many across, so a phone still reads as a library. */
const MIN_COLUMNS = 3;
const GAP = 4;
const HEADING_HEIGHT = 44;

/** A tile's file, and either the drive it is in or the addresses to read it at. */
export interface TileSource {
    readonly path: string;
    readonly connectionId?: string;
    readonly urls?: ThumbnailUrls;
}

export interface PhotoGridHandle {
    /** Bring a listing position into view, wherever its row is. */
    scrollToIndex(index: number): void;
}

const ARROWS: Record<string, "left" | "right" | "up" | "down"> = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down"
};

export function PhotoGrid({
    entries,
    selected,
    cursor,
    byDate,
    source,
    icon,
    wrap,
    onTileClick,
    onOpen,
    onCursor,
    handle
}: {
    /** The listing, in its own order. */
    readonly entries: readonly DriveEntry[];
    readonly selected: ReadonlySet<string>;
    /** Where the keyboard is, as a listing position, or -1. Asked when a key is
     *  pressed, because the listing keeps it outside of React state. */
    readonly cursor: () => number;
    /** The date the listing is sorted by, which is when day headings mean
     *  anything, or null. */
    readonly byDate: "modifiedAt" | "createdAt" | null;
    /** Where a tile's picture is read from (a binned item lives elsewhere, a
     *  public share reads through its own token routes). */
    readonly source: (entry: DriveEntry) => TileSource;
    /** The icon a tile shows while it has no picture, or for good. */
    readonly icon: (entry: DriveEntry) => ReactNode;
    /** The listing's own wrapper for a tile: its context menu and drag. */
    readonly wrap: (entry: DriveEntry, index: number, tile: ReactNode) => ReactNode;
    readonly onTileClick: (event: MouseEvent, index: number, entry: DriveEntry) => void;
    readonly onOpen: (entry: DriveEntry) => void;
    readonly onCursor: (index: number, extend: boolean) => void;
    readonly handle?: Ref<PhotoGridHandle>;
}) {
    const locale = useLocale();
    const scroller = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);

    useEffect(() => {
        const node = scroller.current;
        if (!node) return;
        const measure = () => setWidth(node.clientWidth);
        measure();
        if (typeof ResizeObserver !== "function") return;
        const watch = new ResizeObserver(measure);
        watch.observe(node);
        return () => watch.disconnect();
    }, []);

    const columns = Math.max(MIN_COLUMNS, Math.floor((width + GAP) / (TILE_TARGET + GAP)) || 0);
    const tile = width > 0 ? (width - GAP * (columns - 1)) / columns : TILE_TARGET;
    const rows = useMemo(() => photoRows(entries, columns, byDate), [entries, columns, byDate]);

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scroller.current,
        estimateSize: (row) => (rows[row]?.kind === "heading" ? HEADING_HEIGHT : tile + GAP),
        overscan: 4
    });
    // Every row's height depends on the width, which the virtualizer cannot see.
    useEffect(() => virtualizer.measure(), [virtualizer, tile, rows]);

    useImperativeHandle(
        handle,
        () => ({
            scrollToIndex(index: number) {
                const row = rowOfIndex(rows, index);
                if (row >= 0) virtualizer.scrollToIndex(row, { align: "auto" });
            }
        }),
        [rows, virtualizer]
    );

    const dayLabel = useMemo(() => {
        const thisYear = new Date().getFullYear();
        const short = new Intl.DateTimeFormat(locale, {
            weekday: "short",
            day: "numeric",
            month: "short"
        });
        const long = new Intl.DateTimeFormat(locale, {
            weekday: "short",
            day: "numeric",
            month: "short",
            year: "numeric"
        });
        return (day: string) => {
            const [year, month, date] = day.split("-").map(Number);
            if (!year || !month || !date) return "";
            const at = new Date(year, month - 1, date);
            return (year === thisYear ? short : long).format(at);
        };
    }, [locale]);

    function onKeyDown(event: KeyboardEvent) {
        const direction = ARROWS[event.key];
        if (!direction || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
            return;
        // A rename field on a tile keeps its caret keys.
        const target = event.target as HTMLElement | null;
        if (target?.closest?.("input, textarea, [contenteditable='true']")) return;
        // The listing moves by one for every arrow, which in a grid of rows is
        // wrong for up and down - answered here instead, and kept from it.
        event.preventDefault();
        event.stopPropagation();
        const next = photoNeighbour(rows, cursor(), direction, entries.length);
        if (next !== null) onCursor(next, event.shiftKey);
    }

    return (
        <div
            ref={scroller}
            // Focusable, so a click on a tile puts the keys here rather than on
            // the listing around it, which moves by one for every arrow.
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="max-h-[65vh] overflow-auto overscroll-contain outline-none"
        >
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                    const row = rows[item.index];
                    if (!row) return null;
                    return (
                        <div
                            key={item.key}
                            className="absolute left-0 top-0 w-full"
                            style={{ transform: `translateY(${item.start}px)`, height: item.size }}
                        >
                            {row.kind === "heading" ? (
                                <h3 className="flex h-full items-end gap-2 px-1 pb-2 text-sm font-medium text-foreground">
                                    <span className="min-w-0 truncate">{dayLabel(row.day)}</span>
                                </h3>
                            ) : (
                                <div className="flex" style={{ gap: GAP }}>
                                    {row.indices.map((index) => {
                                        const entry = entries[index];
                                        if (!entry) return null;
                                        return (
                                            <PhotoTile
                                                key={entry.path}
                                                entry={entry}
                                                index={index}
                                                size={tile}
                                                selected={selected.has(entry.path)}
                                                source={source(entry)}
                                                icon={icon(entry)}
                                                wrap={wrap}
                                                onClick={onTileClick}
                                                onOpen={onOpen}
                                            />
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function PhotoTile({
    entry,
    index,
    size,
    selected,
    source,
    icon,
    wrap,
    onClick,
    onOpen
}: {
    readonly entry: DriveEntry;
    readonly index: number;
    readonly size: number;
    readonly selected: boolean;
    readonly source: TileSource;
    readonly icon: ReactNode;
    readonly wrap: (entry: DriveEntry, index: number, tile: ReactNode) => ReactNode;
    readonly onClick: (event: MouseEvent, index: number, entry: DriveEntry) => void;
    readonly onOpen: (entry: DriveEntry) => void;
}) {
    const kind = entry.kind === "file" ? mediaKindOf(entry.name) : null;
    const face = kind ? (
        <EntryThumbnail
            connectionId={source.connectionId}
            urls={source.urls}
            path={source.path}
            version={`${entry.modifiedAt}-${entry.size}`}
            moving={kind === "video"}
            fill
            className="size-full overflow-hidden"
        >
            {icon}
        </EntryThumbnail>
    ) : (
        <span className="flex size-full flex-col items-center justify-center gap-1.5 p-2">
            {icon}
            <span className="w-full min-w-0 truncate text-center text-xs" title={entry.name}>
                {entry.name}
            </span>
        </span>
    );
    return wrap(
        entry,
        index,
        <div
            data-drive-row
            aria-label={entry.name}
            title={entry.name}
            onClick={(event) => onClick(event, index, entry)}
            onDoubleClick={() => onOpen(entry)}
            style={{ width: size, height: size }}
            className={cn(
                "relative shrink-0 cursor-default overflow-hidden rounded-md bg-muted/40",
                entry.hidden && "opacity-50",
                selected && "ring-2 ring-primary ring-offset-1 ring-offset-background"
            )}
        >
            {face}
            {kind === "video" ? (
                <span className="pointer-events-none absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-black/55 text-white">
                    <Play className="size-3.5 shrink-0" aria-hidden />
                </span>
            ) : null}
            {selected ? (
                <span className="pointer-events-none absolute inset-0 bg-primary/15" aria-hidden />
            ) : null}
        </div>
    );
}
