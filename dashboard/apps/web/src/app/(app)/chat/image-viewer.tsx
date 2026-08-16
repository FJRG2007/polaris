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

import { copyText } from "./links";
import { useAppUrl } from "@/components/app-url";
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

export interface ViewedImage {
    readonly url: string;
    readonly name: string;
    /** The message it is on, for forwarding and reporting. */
    readonly messageId: string;
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

    const download = () => {
        // A plain link with a name on it: the route serves it with the name it
        // was uploaded under, and this is what makes the browser save rather
        // than navigate.
        const anchor = document.createElement("a");
        anchor.href = `${image.url}?download=1`;
        anchor.download = image.name;
        anchor.click();
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
            <Item onSelect={download}>
                <Download className="size-3.5" />
                Download
            </Item>
            <Item onSelect={() => window.open(image.url, "_blank", "noopener,noreferrer")}>
                <ExternalLink className="size-3.5" />
                Open in the browser
            </Item>
            {onForward && (
                <Item onSelect={() => onForward(image.messageId)}>
                    <Forward className="size-3.5" />
                    Forward
                </Item>
            )}
            {onReport && (
                <>
                    <Separator />
                    <Item variant="danger" onSelect={() => onReport(image.messageId)}>
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
            // A press on the backdrop closes, the way every viewer does. Not on
            // the picture itself, which is the thing being looked at.
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
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
                            event.currentTarget.setPointerCapture(event.pointerId);
                        }}
                        onPointerMove={(event) => {
                            const from = dragging.current;
                            if (!from) return;
                            setAt({ x: event.clientX - from.x, y: event.clientY - from.y });
                        }}
                        onPointerUp={() => {
                            dragging.current = null;
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
