/**
 * Which copy of somebody's video this browser asks the media server for.
 *
 * Every camera and shared screen goes up in several sizes, and the server
 * forwards each viewer the one that viewer asks for. The media client can work
 * that out by itself (`adaptiveStream`), but only for a track handed to its own
 * `attach()` - and the tiles here draw a `MediaStream` straight into their own
 * `<video>`, so it never saw a single one: every viewer asked for the top copy
 * of everything, a face in a 160px tile included, and a shared screen being
 * stared at full screen was no more likely to arrive sharp than one in a corner.
 *
 * So the tiles say it themselves. Each one reports the size it is drawn at, in
 * device pixels, and whether it is the picture somebody is looking at - focused
 * or full screen. A track shown in two places gets the larger of the two asks.
 *
 * `layerWant` is the rule, kept pure so it can be checked without a call.
 */

import { useEffect, useRef, type RefObject } from "react";

/** What one tile asks for: the top copy, or a copy at least this big. */
export type LayerWant = { readonly top: true } | { readonly width: number; readonly height: number };

/**
 * The short edge a shared screen is never asked for below, focused or not.
 *
 * A screen is text more often than not, and the reason anybody looks at one is
 * to read it. Its first fallback copy is 720p (`screenLayers`), so asking for
 * less than that only ever chose a picture somebody had to squint at.
 */
export const SCREEN_MIN_EDGE = 720;

export function layerWant(tile: {
    readonly screen: boolean;
    /** The picture somebody is looking at: focused, pinned or full screen. */
    readonly focused: boolean;
    readonly width: number;
    readonly height: number;
    /** Device pixels per CSS pixel. */
    readonly density: number;
}): LayerWant | null {
    if (tile.focused) return { top: true };
    const density = tile.density > 0 ? tile.density : 1;
    const width = Math.ceil(tile.width * density);
    const height = Math.ceil(tile.height * density);
    // Not laid out yet, or hidden: nothing to say about it.
    if (width <= 0 || height <= 0) return null;
    if (!tile.screen) return { width, height };
    const edge = Math.min(width, height);
    if (edge >= SCREEN_MIN_EDGE) return { width, height };
    const scale = SCREEN_MIN_EDGE / edge;
    return { width: Math.ceil(width * scale), height: Math.ceil(height * scale) };
}

/** Several tiles showing the same track: the top copy if any of them wants it,
 *  otherwise the largest size any of them is drawn at. */
export function combineWants(wants: Iterable<LayerWant>): LayerWant | null {
    let width = 0;
    let height = 0;
    let any = false;
    for (const want of wants) {
        if ("top" in want) return want;
        any = true;
        if (want.width + want.height > width + height) {
            width = want.width;
            height = want.height;
        }
    }
    return any ? { width, height } : null;
}

/** How a subscribed track is told what to send, filled in by the call hook. */
export type LayerSink = (want: LayerWant) => void;

interface Entry {
    sink: LayerSink | null;
    readonly wants: Map<symbol, LayerWant>;
    last: string;
}

const entries = new Map<string, Entry>();

function entryFor(trackId: string): Entry {
    let entry = entries.get(trackId);
    if (!entry) {
        entry = { sink: null, wants: new Map(), last: "" };
        entries.set(trackId, entry);
    }
    return entry;
}

function apply(entry: Entry): void {
    const want = combineWants(entry.wants.values());
    if (!want || !entry.sink) return;
    const key = "top" in want ? "top" : `${want.width}x${want.height}`;
    if (key === entry.last) return;
    entry.last = key;
    entry.sink(want);
}

function forget(trackId: string, entry: Entry): void {
    if (!entry.sink && entry.wants.size === 0) entries.delete(trackId);
}

/** The call hook, when a remote video track is subscribed and when it goes. */
export function bindLayerSink(trackId: string, sink: LayerSink | null): void {
    const entry = entryFor(trackId);
    entry.sink = sink;
    entry.last = "";
    if (sink) apply(entry);
    else forget(trackId, entry);
}

/** One tile's ask, replaced on every resize and dropped when it unmounts. */
export function setLayerWant(trackId: string, tile: symbol, want: LayerWant | null): void {
    const entry = entryFor(trackId);
    if (want) entry.wants.set(tile, want);
    else entry.wants.delete(tile);
    apply(entry);
    forget(trackId, entry);
}

/**
 * Report this tile's size and focus for the video track in `stream`.
 *
 * Your own camera and screen are in the registry under no sink, so asking for
 * them is a no-op rather than something to special-case.
 */
export function useLayerRequest(
    stream: MediaStream | null,
    element: RefObject<HTMLElement | null>,
    tile: { readonly screen: boolean; readonly focused: boolean }
): void {
    const id = useRef(Symbol("tile"));
    const { screen, focused } = tile;
    useEffect(() => {
        const node = element.current;
        const track = stream?.getVideoTracks()[0];
        if (!node || !track) return;
        const trackId = track.id;
        const key = id.current;
        const report = () =>
            setLayerWant(
                trackId,
                key,
                layerWant({
                    screen,
                    focused: focused || document.fullscreenElement?.contains(node) === true,
                    width: node.clientWidth,
                    height: node.clientHeight,
                    density: window.devicePixelRatio
                })
            );
        report();
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(report);
        observer?.observe(node);
        document.addEventListener("fullscreenchange", report);
        return () => {
            observer?.disconnect();
            document.removeEventListener("fullscreenchange", report);
            setLayerWant(trackId, key, null);
        };
    }, [stream, element, screen, focused]);
}
