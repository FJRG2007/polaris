"use client";

/**
 * A picture, opened.
 *
 * Inside Polaris rather than in a new tab, because a new tab is a browser's
 * image viewer: no way back, no way to forward it, and on a phone it is a
 * navigation somebody has to undo. What people actually do with a picture in a
 * conversation is look closer at it, save it, or send it on, and all three are
 * here.
 *
 * One viewer for every picture in Polaris rather than one per screen. It was the
 * conversation's, and a profile photo opened from a face is the same gesture
 * wanting the same thing - so what belongs to a message (forwarding it, reporting
 * it) is what the caller passes in, and a picture with no message behind it
 * simply gets neither.
 *
 * Zoom is the pointer's, which is the only kind that feels right: the wheel, a
 * trackpad pinch and two fingers zoom around where they are, and a drag moves
 * the picture rather than the page. Double-press (or double-tap) toggles between
 * fit and close up, which is the gesture every viewer has settled on. It is the
 * same engine as the calls' and the cameras' zoom - see `use-zoom-pan`.
 *
 * The menu is the same set twice - once as three dots and once as the right
 * click - because those are two habits and neither is wrong. What is in it is
 * `image-actions`, shared with the conversation: right-clicking a picture in a
 * message offers the same things without opening it first.
 *
 * Embedded, it is only the stage: a screen with its own frame around a picture
 * (Drive's preview, with its header, stepping and flight) draws the picture
 * here so zoom, pan and fit behave the way they do everywhere else, and keeps
 * everything else its own. The frame never resizes while stepping: the last
 * picture stays up until the next one has decoded, then swaps in place.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as flying from "./flight";
import { useZoomPan } from "../lib/use-zoom-pan";
import { MoreHorizontal, X, ZoomIn, ZoomOut, ChevronLeft, ChevronRight } from "lucide-react";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    cn,
    shortcutPressed
} from "../index";

/** How the next picture arrives: from this far to the side, over this long. */
const SLIDE_PX = 48;
const SLIDE_MS = 200;

/** How far a pointer may wander and still count as a press rather than a drag.
 *  A hand on a trackpad or a thumb on glass never lands on exactly one pixel. */
const DRAG_SLOP = 4;

/** A picture, as the viewer needs it - which is what any menu about a picture
 *  needs, so it is the shared shape rather than a second one beside it. */
export interface ViewedImage {
    readonly url: string;
    readonly name: string;
    /** The message it is on, for forwarding and reporting. Absent for a picture
     *  that is not in a conversation - a profile photo, which there is nowhere
     *  to forward and nothing to report. */
    readonly messageId?: string;
    /** Whether whoever sent it lets it be passed on. The menu offers the action
     *  or does not; it never offers one that would be refused. */
    readonly forwardable?: boolean;
    /** A blurred stand-in (an image address, such as a decoded ThumbHash) shown
     *  at the picture's shape until the picture itself has arrived. */
    readonly placeholder?: string;
}

/** The viewer's own words, in the reader's language. */
export interface ViewerLabels {
    readonly zoomIn: string;
    readonly zoomOut: string;
    readonly more: string;
    readonly close: string;
    readonly previous: string;
    readonly next: string;
    /** Back to fit, for the embedded stage's zoom chip. Falls back to zoomOut. */
    readonly fit?: string;
    /** "3 of 7", for a picture that is one of a set. */
    position(index: number, count: number): string;
}

/** What the menu holds for a picture, drawn twice: once as the three dots and
 *  once as the right click, so it is given the item parts to draw with. */
export type ViewerMenu = (props: {
    image: ViewedImage;
    announce: (words: string) => void;
    Item: typeof DropdownMenuItem;
    Separator: typeof DropdownMenuSeparator;
}) => ReactNode;

/** Where a picture flies in from and back to: its thumbnail on the page. */
export type ImageOrigin = (image: ViewedImage) => Element | null;

/** The page's own copy of a picture, found by its address, outside any viewer. */
export function thumbnailOf(image: ViewedImage): Element | null {
    if (typeof document === "undefined") return null;
    const wanted = new URL(image.url, document.baseURI).href;
    for (const img of document.querySelectorAll("img")) {
        if (img.closest("[data-image-viewer]")) continue;
        if (img.src === wanted || img.currentSrc === wanted) return img;
    }
    return null;
}

/** The layers that fade while the picture flies: backdrop, toolbar, arrows. */
function fadeChrome(root: HTMLElement | null, from: number, to: number, duration: number): void {
    for (const layer of root?.querySelectorAll<HTMLElement>("[data-viewer-chrome]") ?? []) {
        if (typeof layer.animate !== "function") return;
        layer.animate([{ opacity: from }, { opacity: to }], {
            duration,
            easing: flying.EASE,
            fill: "forwards"
        });
    }
}

export function ImageViewer({
    image,
    onClose,
    labels,
    menu,
    gallery,
    onNavigate,
    origin = thumbnailOf,
    embedded = false,
    onPictureLoad
}: {
    /** The picture being looked at, or null for none. */
    image: ViewedImage | null;
    onClose: () => void;
    /** The thumbnail each picture grows out of and shrinks back into. With none
     *  on screen it fades and scales in place instead. */
    origin?: ImageOrigin;
    /** The pictures it is one of, in order, for the arrows and the arrow keys -
     *  a set of screenshots is looked through, not opened one by one. */
    gallery?: readonly ViewedImage[];
    onNavigate?: (image: ViewedImage) => void;
    labels: ViewerLabels;
    /** The picture's menu. With none, the viewer has no three dots and leaves
     *  the right click to the browser. */
    menu?: ViewerMenu;
    /** Only the stage, filling the caller's frame: no dialog, bar, arrows,
     *  Escape or flight - the caller has its own. Zoom, pan and fit stay. */
    embedded?: boolean;
    /** The picture on screen finished loading (each one, as it swaps in). */
    onPictureLoad?: (picture: HTMLImageElement) => void;
}) {
    // Zoom and pan never go through React while a gesture lasts: the hook
    // moves the picture on the compositor and tells this component once it
    // settles. See `use-zoom-pan`.
    const look = useZoomPan();
    const { reset, zoomIn, zoomOut, targetRef } = look;
    const [said, setSaid] = useState("");
    /** Where a press started and whether it started off the picture, so a press
     *  on the dark around it can close and a drag across it cannot. */
    const press = useRef<ViewerPress | null>(null);
    const root = useRef<HTMLDivElement | null>(null);
    const picture = useRef<HTMLImageElement | null>(null);
    const pictureRef = useCallback(
        (node: HTMLImageElement | null) => {
            picture.current = node;
            return targetRef(node);
        },
        [targetRef]
    );
    // Which picture has arrived, for its blurred stand-in to step aside.
    const [arrivedUrl, setArrivedUrl] = useState<string | null>(null);
    // Whether this opening has flown in yet, and whether it is on its way out.
    // Moving to the next picture is not an opening, so it does not fly.
    const flown = useRef(false);
    const closing = useRef(false);
    const shown = image !== null;
    // Embedded, what is painted lags what was asked for until it has decoded,
    // so a step never blanks the frame or collapses it to nothing first.
    const [painted, setPainted] = useState<string | null>(image?.url ?? null);
    const wanted = image?.url ?? null;
    useEffect(() => {
        if (!embedded || wanted === null || wanted === painted) return;
        let live = true;
        const probe = new Image();
        probe.src = wanted;
        const swap = () => {
            if (live) setPainted(wanted);
        };
        // A picture that will not decode still swaps, so its own failure shows
        // rather than the last picture under the wrong name.
        if (typeof probe.decode === "function") probe.decode().then(swap, swap);
        else swap();
        return () => {
            live = false;
        };
    }, [embedded, wanted, painted]);

    /** Which way the last arrow went, so the next picture slides in from there. */
    const sliding = useRef<-1 | 1 | null>(null);

    useLayoutEffect(() => {
        if (!shown || embedded) return;
        flown.current = false;
        closing.current = false;
        if (!flying.reducedMotion()) fadeChrome(root.current, 0, 1, flying.OPEN_MS);
        // The viewer takes the keys while it is open. Left where it was, focus
        // stays on the thumbnail that opened it, and a strip of thumbnails that
        // pages on the arrow keys answers them first - the picture behind the
        // viewer moved and the one in it did not. Given back on close.
        const before = document.activeElement;
        root.current?.focus({ preventScroll: true });
        return () => {
            if (before instanceof HTMLElement && before.isConnected) {
                before.focus({ preventScroll: true });
            }
        };
    }, [shown, embedded]);

    /** The next picture comes in from the side it was asked for. */
    const slideIn = useCallback(() => {
        const element = picture.current;
        const from = sliding.current;
        sliding.current = null;
        if (!from || !element || typeof element.animate !== "function") return;
        if (flying.reducedMotion()) return;
        element.animate(
            [
                { opacity: 0, translate: `${from * SLIDE_PX}px 0` },
                { opacity: 1, translate: "0 0" }
            ],
            { duration: SLIDE_MS, easing: flying.EASE }
        );
    }, []);

    /** Grow the picture out of its thumbnail, once it has a size to grow to. */
    const flyIn = useCallback(() => {
        const element = picture.current;
        if (embedded || !image || !element || flown.current || closing.current) return;
        if (element.offsetWidth < 1) return;
        flown.current = true;
        if (!flying.canFly(element)) return;
        flying.growIn(
            element,
            flying.boxOf(element),
            flying.visibleBox(origin(image), flying.viewportSize())
        );
    }, [image, origin, embedded]);

    useLayoutEffect(() => {
        if (picture.current?.complete) flyIn();
    }, [flyIn]);

    /** Shrink back into the thumbnail - the current picture's, while it is on
     *  screen - and only then let the caller take the viewer away. */
    const close = useCallback(() => {
        const element = picture.current;
        if (closing.current) return;
        if (!image || !flying.canFly(element)) {
            onClose();
            return;
        }
        closing.current = true;
        // The box as laid out, before the zoom's transform: offsets ignore
        // transforms, so they are measured from the stage the picture sits in.
        const stage = element.offsetParent?.getBoundingClientRect();
        const laidOut = {
            x: (stage?.left ?? 0) + element.offsetLeft,
            y: (stage?.top ?? 0) + element.offsetTop,
            width: element.offsetWidth,
            height: element.offsetHeight
        };
        const now = getComputedStyle(element).transform;
        fadeChrome(root.current, 1, 0, flying.CLOSE_MS);
        void flying
            .shrinkOut(
                element,
                laidOut,
                flying.visibleBox(origin(image), flying.viewportSize()),
                now && now !== "none" ? now : "none"
            )
            .then(onClose);
    }, [image, onClose, origin]);

    // Back to fit whenever a different picture is opened: reopening one at three
    // times the size, panned into a corner, is the last picture's state wearing
    // this one's pixels.
    useEffect(() => {
        reset({ animate: false });
        setSaid("");
    }, [image?.url, reset]);

    const position = image && gallery ? gallery.findIndex((one) => one.url === image.url) : -1;
    const browsable = Boolean(onNavigate && gallery && gallery.length > 1 && position >= 0);
    const go = useCallback(
        (by: -1 | 1) => {
            if (!browsable || !gallery || !onNavigate) return;
            sliding.current = by;
            // Round the ends, the way every gallery does: past the last is the first.
            onNavigate(gallery[(position + by + gallery.length) % gallery.length]!);
        },
        [browsable, gallery, onNavigate, position]
    );

    useEffect(() => {
        if (!image) return;
        const onKey = (event: KeyboardEvent) => {
            if (embedded) {
                // The caller owns Escape and stepping; the zoom keys are the
                // picture's, unless somebody is typing somewhere on the page.
                if (typingIn(event.target)) return;
                if (shortcutPressed(event, "viewer.zoomIn")) zoomIn();
                if (shortcutPressed(event, "viewer.zoomOut")) zoomOut();
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                close();
            }
            const inMenu =
                event.defaultPrevented ||
                (event.target instanceof Element && event.target.closest("[role='menu']") !== null);
            if (!inMenu && shortcutPressed(event, "viewer.previousFile")) {
                event.preventDefault();
                go(-1);
            }
            if (!inMenu && shortcutPressed(event, "viewer.nextFile")) {
                event.preventDefault();
                go(1);
            }
            if (shortcutPressed(event, "viewer.zoomIn")) zoomIn();
            if (shortcutPressed(event, "viewer.zoomOut")) zoomOut();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [image, close, go, embedded, zoomIn, zoomOut]);

    const say = useCallback((words: string) => {
        setSaid(words);
        setTimeout(() => setSaid(""), 2000);
    }, []);

    if (!image) return null;

    const items = (Item: typeof DropdownMenuItem, Separator: typeof DropdownMenuSeparator) =>
        menu?.({ image, announce: say, Item, Separator });

    const stage = (
        <div
            ref={look.frameRef}
            className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
            // A zoomed or pinched picture is being moved, not swiped past: the
            // caller's swipe-to-step never hears a touch that is panning it.
            // Read live, because a pinch that started unzoomed has not told
            // React yet by the time its fingers lift.
            onTouchStart={
                embedded ? (event) => look.engaged() && event.stopPropagation() : undefined
            }
            onTouchEnd={
                embedded ? (event) => look.engaged() && event.stopPropagation() : undefined
            }
            onDoubleClick={look.frameProps.onDoubleClick}
            onPointerDown={(event) => {
                press.current = {
                    x: event.clientX,
                    y: event.clientY,
                    // The stage is everything under the bar, so the
                    // dark around the picture is this element itself
                    // and the picture is a child of it. Recorded on
                    // the press because the pointer is captured from
                    // here on, and every later event says "stage".
                    outside: event.target === event.currentTarget
                };
                look.frameProps.onPointerDown(event);
            }}
            onPointerMove={look.frameProps.onPointerMove}
            // A press on the dark closes, the way every viewer does -
            // but only a press. A drag that started there was somebody
            // moving the picture, and closing on it would undo the
            // gesture they were in the middle of.
            onPointerUp={(event) => {
                const from = press.current;
                press.current = null;
                look.frameProps.onPointerUp(event);
                if (!embedded && closesOnRelease(from, event)) close();
            }}
            onPointerCancel={(event) => {
                press.current = null;
                look.frameProps.onPointerCancel(event);
            }}
        >
            {image.placeholder && arrivedUrl !== image.url && (
                // eslint-disable-next-line @next/next/no-img-element -- a few-pixel data URL
                <img
                    src={image.placeholder}
                    alt=""
                    aria-hidden
                    draggable={false}
                    className="pointer-events-none absolute inset-0 size-full select-none object-contain"
                />
            )}
            {/* eslint-disable-next-line @next/next/no-img-element -- one picture, sized by the viewer */}
            <img
                ref={pictureRef}
                data-viewer-picture=""
                decoding="async"
                onLoad={(event) => {
                    setArrivedUrl(image.url);
                    flyIn();
                    slideIn();
                    onPictureLoad?.(event.currentTarget);
                    // Decoded at its full size now, off the main thread, while
                    // nobody is touching it. Otherwise the browser decodes only
                    // what the fitted size needs and decodes the whole picture
                    // again the first time it is zoomed - a 20-megapixel PNG
                    // froze the view for a third of a second right there.
                    event.currentTarget.decode?.().catch(() => undefined);
                }}
                src={embedded ? (painted ?? image.url) : image.url}
                alt={image.name}
                draggable={false}
                // No transition class and no shadow or filter here: this is the
                // layer that moves, and anything that repaints with it is paid
                // for on every frame of a pan.
                className={cn(
                    "max-h-full max-w-full select-none object-contain",
                    look.zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
                )}
            />
        </div>
    );

    if (embedded) {
        return (
            <div
                data-image-viewer=""
                data-image-stage=""
                className="relative flex size-full min-h-0 min-w-0 flex-col"
            >
                {menu ? (
                    <ContextMenu>
                        <ContextMenuTrigger asChild>{stage}</ContextMenuTrigger>
                        <ContextMenuContent className="w-56">
                            {items(ContextMenuItem, ContextMenuSeparator)}
                        </ContextMenuContent>
                    </ContextMenu>
                ) : (
                    stage
                )}
                {/* Only once it has been zoomed: back to fit in one press. */}
                {look.zoomed ? (
                    <button
                        type="button"
                        aria-label={labels.fit ?? labels.zoomOut}
                        title={labels.fit ?? labels.zoomOut}
                        onClick={() => reset()}
                        className="absolute end-3 top-3 rounded bg-background/80 px-1.5 py-1 text-[0.6875rem] tabular-nums text-muted-foreground transition-colors hover:text-foreground"
                    >
                        {Math.round(look.zoom.scale * 100)}%
                    </button>
                ) : null}
            </div>
        );
    }

    return (
        <div
            role="dialog"
            data-state="open"
            aria-modal="true"
            aria-label={image.name}
            data-image-viewer=""
            ref={root}
            tabIndex={-1}
            className="fixed inset-0 z-50 flex flex-col safe-p-0 outline-none"
        >
            {/* Its own layer, so it fades while the picture flies. */}
            <div
                data-viewer-chrome=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-background/95"
            />
            <div
                data-viewer-chrome=""
                className="relative flex shrink-0 items-center gap-2 px-3 py-2"
            >
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={image.name}>
                    {image.name}
                </span>
                {said && <span className="shrink-0 text-xs text-muted-foreground">{said}</span>}
                {browsable && gallery ? (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {labels.position(position + 1, gallery.length)}
                    </span>
                ) : null}

                <button
                    type="button"
                    aria-label={labels.zoomOut}
                    onClick={zoomOut}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ZoomOut className="size-4" />
                </button>
                <span className="w-12 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
                    {Math.round(look.zoom.scale * 100)}%
                </span>
                <button
                    type="button"
                    aria-label={labels.zoomIn}
                    onClick={zoomIn}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ZoomIn className="size-4" />
                </button>

                {menu ? (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                aria-label={labels.more}
                                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <MoreHorizontal className="size-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            {items(DropdownMenuItem, DropdownMenuSeparator)}
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : null}

                <button
                    type="button"
                    aria-label={labels.close}
                    onClick={close}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <X className="size-4" />
                </button>
            </div>

            {menu ? (
                <ContextMenu>
                    <ContextMenuTrigger asChild>{stage}</ContextMenuTrigger>
                    <ContextMenuContent className="w-56">
                        {items(ContextMenuItem, ContextMenuSeparator)}
                    </ContextMenuContent>
                </ContextMenu>
            ) : (
                stage
            )}
            {browsable ? (
                <>
                    <button
                        type="button"
                        data-viewer-chrome=""
                        aria-label={labels.previous}
                        title={labels.previous}
                        onClick={() => go(-1)}
                        className="absolute start-3 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full border border-border bg-card/90 text-foreground shadow-sm transition-colors hover:bg-muted"
                    >
                        <ChevronLeft className="size-5 shrink-0" aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        data-viewer-chrome=""
                        aria-label={labels.next}
                        title={labels.next}
                        onClick={() => go(1)}
                        className="absolute end-3 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full border border-border bg-card/90 text-foreground shadow-sm transition-colors hover:bg-muted"
                    >
                        <ChevronRight className="size-5 shrink-0" aria-hidden="true" />
                    </button>
                </>
            ) : null}
        </div>
    );
}

/** Where a press landed, and whether it landed off the picture. */
export interface ViewerPress {
    readonly x: number;
    readonly y: number;
    readonly outside: boolean;
}

/**
 * Whether letting go here closes the viewer.
 *
 * Its own function because the rule reads as one sentence and the bug was that
 * it went unsaid: the press must have started on the dark around the picture,
 * and it must have been a press rather than the end of a pan.
 */
export function closesOnRelease(
    press: ViewerPress | null,
    at: { readonly clientX: number; readonly clientY: number }
): boolean {
    if (!press?.outside) return false;
    return Math.hypot(at.clientX - press.x, at.clientY - press.y) <= DRAG_SLOP;
}

/** Whether a key went to something being typed in. */
function typingIn(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}
