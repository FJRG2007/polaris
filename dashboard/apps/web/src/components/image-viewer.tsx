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
 * Zoom is the pointer's, which is the only kind that feels right: the wheel
 * zooms around where the pointer is, and a drag moves the picture rather than
 * the page. Double-press toggles between fit and life size, which is the gesture
 * every viewer has settled on.
 *
 * The menu is the same set twice - once as three dots and once as the right
 * click - because those are two habits and neither is wrong. Copying the image
 * copies the bytes, which is what somebody pasting into another conversation
 * means; copying the link copies an address only somebody in the conversation
 * can open, which is what somebody quoting it in a ticket means.
 */

import { useAppUrl } from "@/components/app-url";
import { copyText, downloadFile } from "@/app/(app)/chat/links";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    Copy,
    Download,
    ExternalLink,
    Flag,
    Forward,
    Link2,
    MoreHorizontal,
    X,
    ZoomIn,
    ZoomOut
} from "lucide-react";
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
    cn
} from "@polaris/ui";

/** How far in and out a picture goes. Past four times, a photo is pixels; below
 *  a quarter it is a thumbnail nobody asked for. */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

/** What one notch of the wheel does. */
const WHEEL_STEP = 0.0015;

/** How far a pointer may wander and still count as a press rather than a drag.
 *  A hand on a trackpad or a thumb on glass never lands on exactly one pixel. */
const DRAG_SLOP = 4;

export interface ViewedImage {
    readonly url: string;
    readonly name: string;
    /** The message it is on, for forwarding and reporting. Absent for a picture
     *  that is not in a conversation - a profile photo, which there is nowhere
     *  to forward and nothing to report. */
    readonly messageId?: string;
    /** Whether whoever sent it lets it be passed on. The viewer offers the
     *  action or does not; it never offers one that would be refused. */
    readonly forwardable?: boolean;
}

export function ImageViewer({
    image,
    onClose,
    onForward,
    onReport
}: {
    /** The picture being looked at, or null for none. */
    image: ViewedImage | null;
    onClose: () => void;
    /** Send it on. The conversation picker is the caller's - it already has one
     *  for forwarding a message, and a picture is a message. */
    onForward?: (messageId: string) => void;
    onReport?: (messageId: string) => void;
}) {
    const baseUrl = useAppUrl();
    const [zoom, setZoom] = useState(1);
    const [at, setAt] = useState({ x: 0, y: 0 });
    const [said, setSaid] = useState("");
    const dragging = useRef<{ x: number; y: number } | null>(null);
    /** Where a press started and whether it started off the picture, so a press
     *  on the dark around it can close and a drag across it cannot. */
    const press = useRef<ViewerPress | null>(null);

    // Back to fit whenever a different picture is opened: reopening one at three
    // times the size, panned into a corner, is the last picture's state wearing
    // this one's pixels.
    useEffect(() => {
        setZoom(1);
        setAt({ x: 0, y: 0 });
        setSaid("");
    }, [image?.url]);

    useEffect(() => {
        if (!image) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
            if (event.key === "+" || event.key === "=") setZoom((current) => step(current, 1));
            if (event.key === "-") setZoom((current) => step(current, -1));
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [image, onClose]);

    const say = useCallback((words: string) => {
        setSaid(words);
        setTimeout(() => setSaid(""), 2000);
    }, []);

    if (!image) return null;

    /** The address somebody else could open, which is the configured one rather
     *  than whatever hostname this tab happens to be on. */
    const shareable = `${baseUrl}${image.url}`;

    /** The message this picture is on, when it is on one. Read out here so the
     *  two actions that need it are drawn only when there is one to act on. */
    const messageId = image.messageId;

    /**
     * The bytes on the clipboard.
     *
     * Fetched and handed over as a blob, because "copy image" means the picture
     * and not its address - pasting a URL into a chat is a link, and somebody
     * copying an image expects to paste an image. PNG because that is the one
     * format every clipboard implementation takes.
     */
    const copyImage = async () => {
        try {
            const response = await fetch(image.url);
            const blob = await response.blob();
            const painted = await toPng(blob);
            await navigator.clipboard.write([new ClipboardItem({ "image/png": painted })]);
            say("Copied");
        } catch {
            // A browser without the clipboard image API, or a refused permission.
            // The link is the honest fallback and is one press away.
            say("This browser would not take the image - copy the link instead");
        }
    };

    const items = (
        Item: typeof DropdownMenuItem,
        Separator: typeof DropdownMenuSeparator
    ): React.ReactNode => (
        <>
            <Item onSelect={() => void copyImage()}>
                <Copy className="size-3.5" />
                Copy image
            </Item>
            <Item
                onSelect={() => {
                    void copyText(shareable);
                    say("Link copied");
                }}
            >
                <Link2 className="size-3.5" />
                Copy media link
            </Item>
            <Item onSelect={() => downloadFile(image.url, image.name)}>
                <Download className="size-3.5" />
                Download
            </Item>
            <Item onSelect={() => window.open(image.url, "_blank", "noopener,noreferrer")}>
                <ExternalLink className="size-3.5" />
                Open in the browser
            </Item>
            {onForward && image.forwardable && messageId && (
                <Item onSelect={() => onForward(messageId)}>
                    <Forward className="size-3.5" />
                    Forward
                </Item>
            )}
            {onReport && messageId && (
                <>
                    <Separator />
                    <Item variant="danger" onSelect={() => onReport(messageId)}>
                        <Flag className="size-3.5" />
                        Report
                    </Item>
                </>
            )}
        </>
    );

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={image.name}
            className="fixed inset-0 z-50 flex flex-col bg-background/95"
        >
            <div className="flex shrink-0 items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={image.name}>
                    {image.name}
                </span>
                {said && <span className="shrink-0 text-xs text-muted-foreground">{said}</span>}

                <button
                    type="button"
                    aria-label="Zoom out"
                    onClick={() => setZoom((current) => step(current, -1))}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ZoomOut className="size-4" />
                </button>
                <span className="w-12 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
                    {Math.round(zoom * 100)}%
                </span>
                <button
                    type="button"
                    aria-label="Zoom in"
                    onClick={() => setZoom((current) => step(current, 1))}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ZoomIn className="size-4" />
                </button>

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            aria-label="More for this picture"
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <MoreHorizontal className="size-4" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        {items(DropdownMenuItem, DropdownMenuSeparator)}
                    </DropdownMenuContent>
                </DropdownMenu>

                <button
                    type="button"
                    aria-label="Close"
                    onClick={onClose}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <X className="size-4" />
                </button>
            </div>

            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <div
                        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
                        onWheel={(event) => {
                            setZoom((current) =>
                                clamp(current * Math.exp(-event.deltaY * WHEEL_STEP))
                            );
                        }}
                        onDoubleClick={() => {
                            setZoom((current) => (current === 1 ? 2 : 1));
                            setAt({ x: 0, y: 0 });
                        }}
                        onPointerDown={(event) => {
                            dragging.current = { x: event.clientX - at.x, y: event.clientY - at.y };
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
                            event.currentTarget.setPointerCapture(event.pointerId);
                        }}
                        onPointerMove={(event) => {
                            const from = dragging.current;
                            if (!from) return;
                            setAt({ x: event.clientX - from.x, y: event.clientY - from.y });
                        }}
                        // A press on the dark closes, the way every viewer does -
                        // but only a press. A drag that started there was somebody
                        // moving the picture, and closing on it would undo the
                        // gesture they were in the middle of.
                        onPointerUp={(event) => {
                            const from = press.current;
                            dragging.current = null;
                            press.current = null;
                            if (closesOnRelease(from, event)) onClose();
                        }}
                        onPointerCancel={() => {
                            dragging.current = null;
                            press.current = null;
                        }}
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element -- one picture, sized by the viewer */}
                        <img
                            src={image.url}
                            alt={image.name}
                            draggable={false}
                            style={{
                                transform: `translate(${at.x}px, ${at.y}px) scale(${zoom})`
                            }}
                            className={cn(
                                "max-h-full max-w-full select-none object-contain transition-transform duration-fast",
                                zoom > 1 ? "cursor-grab" : "cursor-zoom-in"
                            )}
                        />
                    </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-56">
                    {items(ContextMenuItem, ContextMenuSeparator)}
                </ContextMenuContent>
            </ContextMenu>
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

function clamp(value: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/** One press of a zoom button: a quarter either way, which is enough to see the
 *  change and small enough to land where somebody meant. */
function step(current: number, direction: 1 | -1): number {
    return clamp(current + direction * 0.25);
}

/**
 * The picture as a PNG.
 *
 * Clipboards take PNG and argue about everything else - a WebP or an AVIF handed
 * over as itself is a paste that silently does nothing in half the applications
 * somebody would paste into. Anything already a PNG is passed straight through.
 */
async function toPng(blob: Blob): Promise<Blob> {
    if (blob.type === "image/png") return blob;
    const bitmap = await createImageBitmap(blob);
    try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser cannot convert the image");
        context.drawImage(bitmap, 0, 0);
        const painted = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/png")
        );
        if (!painted) throw new Error("This browser cannot convert the image");
        return painted;
    } finally {
        bitmap.close();
    }
}
