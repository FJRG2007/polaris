"use client";

/**
 * In-dashboard file viewer. `FilePreview` renders a file's bytes by type and the
 * `FileViewer` modal wraps it for the contexts that have nowhere to put it
 * inline (a public share). The Drive explorer embeds `FilePreview` directly.
 * By type: images natively, audio/video through a Polaris-themed Plyr, PDFs in
 * an in-dashboard pdf.js viewer that also annotates them, spreadsheets/CSV in
 * an editable grid, .docx read-only through mammoth, .pptx read-only as scaled
 * slides, source files as editable highlighted code, and anything else as
 * editable plain text (Notepad-style), binary or oversized files read-only.
 * Each viewer lives in ./viewer and pulls its heavy library in dynamically, so
 * nothing runs during SSR and a library only loads when a file of that type is
 * opened. Bytes are streamed from the drive route with an inline disposition
 * (Range-enabled, so media scrubbing works) and stay same-origin, so no external
 * assets are ever fetched.
 */

import { viewerKind } from "./viewer/kind";
import { formatBytes } from "@polaris/core";
import { DocView } from "./viewer/doc-view";
import { PdfView } from "./viewer/pdf-view";
import { CodeView } from "./viewer/code-view";
import { PptxView } from "./viewer/pptx-view";
import { extensionOf } from "./file-categories";
import { MediaView } from "./viewer/media-view";
import { SheetEditor } from "./viewer/sheet-editor";
import { MarkdownView } from "./viewer/markdown-view";
import { PlainTextEditor } from "./viewer/text-editor";
import { useDisplayFormat } from "@/components/display-format";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ViewerTarget, ViewerUrlFor } from "./viewer/types";
import { startDownload, useDownloadsPending } from "@/lib/drive/downloads";
import { ChevronLeft, ChevronRight, Download, Loader2, Share2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@polaris/ui";

export type { ViewerTarget, ViewerUrlFor, ViewerKind } from "./viewer/types";
export { isViewable, viewerKind } from "./viewer/kind";

/** Default byte URL for a Drive-owned file (served by the session-scoped route). */
export function driveByteUrl(target: ViewerTarget, inline: boolean): string {
    const query = new URLSearchParams({ c: target.connectionId ?? "", p: target.path });
    if (inline) query.set("disposition", "inline");
    return `/api/drive/download?${query.toString()}`;
}

/**
 * A file's bytes rendered by whichever viewer its extension selects. Kept apart
 * from the dialog so the Drive explorer can show the same preview inline, next
 * to its own details panel, while a public share still opens it in a modal.
 */
export function FilePreview({
    target,
    onSaved,
    urlFor,
    token,
    readOnly = false
}: {
    target: ViewerTarget;
    onSaved?: (name: string) => void;
    urlFor?: ViewerUrlFor;
    /** The share this is being viewed through, when it is one. A presentation is
     *  rendered by the server, and that request needs the same pass the bytes
     *  came through - a share visitor has no session to authorise it. */
    token?: string;
    readOnly?: boolean;
}) {
    const src = (urlFor ?? driveByteUrl)(target, true);
    const kind = viewerKind(target.name);

    if (kind === "image") {
        return (
            <div className="flex items-center justify-center p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src={src}
                    alt={target.name}
                    className="max-h-[80vh] max-w-full object-contain"
                />
            </div>
        );
    }
    if (kind === "video" || kind === "audio") {
        // The same address the toolbar's own save uses: served as a file rather
        // than to be played, which is the difference between saving it and
        // navigating to it.
        return (
            <MediaView src={src} kind={kind} download={(urlFor ?? driveByteUrl)(target, false)} />
        );
    }
    if (kind === "pdf")
        return <PdfView src={src} target={target} readOnly={readOnly} onSaved={onSaved} />;
    if (kind === "sheet")
        return <SheetEditor src={src} target={target} readOnly={readOnly} onSaved={onSaved} />;
    if (kind === "doc")
        return <DocView src={src} target={target} readOnly={readOnly} onSaved={onSaved} />;
    if (kind === "slides") return <PptxView src={src} token={token} />;
    if (kind === "markdown")
        return <MarkdownView src={src} target={target} readOnly={readOnly} onSaved={onSaved} />;
    if (kind === "code")
        return <CodeView src={src} target={target} readOnly={readOnly} onSaved={onSaved} />;
    return <PlainTextEditor src={src} target={target} readOnly={readOnly} onSaved={onSaved} />;
}

/**
 * Where the open file sits among the ones opened with it, and how to move.
 *
 * A message with six attachments is read one after another, and closing the
 * viewer to open the next is the step every mail client removed. Left and Right
 * move too, unless the key is somebody typing or a player seeking.
 */
export interface ViewerSteps {
    /** Zero-based position of the open file. */
    readonly index: number;
    readonly count: number;
    readonly onStep: (by: -1 | 1) => void;
}

/** What answers Left and Right itself: text being edited, and anything that
 *  slides - a media player's seek bar, a zoom. */
const OWNS_ARROW_KEYS = [
    "input",
    "textarea",
    "select",
    "[contenteditable='']",
    "[contenteditable='true']",
    "[role='slider']",
    "[role='textbox']"
].join(", ");

/** Whether a key press belongs to whatever it was pressed in rather than to the
 *  viewer's own Left/Right: a field, an editor, or a control that already
 *  answered it. */
function keyBelongsToTarget(event: ReactKeyboardEvent): boolean {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return true;
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== "function") return false;
    return target.closest(OWNS_ARROW_KEYS) !== null;
}

export function FileViewer({
    target,
    onOpenChange,
    onShare,
    onSaved,
    urlFor,
    token,
    readOnly = false,
    steps
}: {
    target: ViewerTarget | null;
    onOpenChange: (open: boolean) => void;
    onShare?: (target: ViewerTarget) => void;
    /** A file was written from an editor (the file itself or a copy): refresh the listing. */
    onSaved?: (name: string) => void;
    /** Override the byte-URL source (a public share serves through its token route). */
    urlFor?: ViewerUrlFor;
    /** Read-only viewing: hide inline editing (a share visitor cannot write back). */
    readOnly?: boolean;
    /** The share token this is opened through, when it is a public link. */
    token?: string;
    /** Several files opened together - see `ViewerSteps`. Nothing is drawn for one. */
    steps?: ViewerSteps;
}) {
    const format = useDisplayFormat();
    const byteUrl = urlFor ?? driveByteUrl;
    // Whether the server has answered the last request for bytes yet, so a file
    // on a slow share says it is coming - see `drive/downloads`.
    const preparing = useDownloadsPending();
    const extension = target ? extensionOf(target.name) : "";
    const stepping = steps && steps.count > 1 ? steps : null;
    const canBack = stepping !== null && stepping.index > 0;
    const canForward = stepping !== null && stepping.index < stepping.count - 1;

    return (
        <Dialog open={target !== null} onOpenChange={onOpenChange}>
            <DialogContent
                className="flex max-h-[90vh] w-full max-w-6xl flex-col gap-0 overflow-hidden p-0"
                onKeyDown={(event) => {
                    if (!stepping || keyBelongsToTarget(event)) return;
                    if (event.key === "ArrowLeft" && canBack) {
                        event.preventDefault();
                        stepping.onStep(-1);
                    } else if (event.key === "ArrowRight" && canForward) {
                        event.preventDefault();
                        stepping.onStep(1);
                    }
                }}
            >
                <DialogHeader className="flex flex-row items-center justify-between gap-3 px-4 py-3">
                    <DialogTitle className="min-w-0 truncate text-sm">{target?.name}</DialogTitle>
                    {target ? (
                        <div className="mr-8 flex shrink-0 items-center gap-2">
                            {stepping ? (
                                <div className="flex items-center gap-0.5">
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label="Previous file"
                                        title="Previous file"
                                        disabled={!canBack}
                                        onClick={() => stepping.onStep(-1)}
                                    >
                                        <ChevronLeft className="size-4 shrink-0" aria-hidden />
                                    </Button>
                                    <span
                                        className="min-w-[3.5rem] text-center text-xs tabular-nums text-muted-foreground"
                                        aria-live="polite"
                                    >
                                        {stepping.index + 1} of {stepping.count}
                                    </span>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label="Next file"
                                        title="Next file"
                                        disabled={!canForward}
                                        onClick={() => stepping.onStep(1)}
                                    >
                                        <ChevronRight className="size-4 shrink-0" aria-hidden />
                                    </Button>
                                </div>
                            ) : null}
                            {onShare ? (
                                <Button size="sm" variant="ghost" onClick={() => onShare(target)}>
                                    <Share2 className="size-4" />
                                    Share
                                </Button>
                            ) : null}
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={preparing > 0}
                                onClick={() => startDownload(byteUrl(target, false), target.name)}
                            >
                                {preparing > 0 ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <Download className="size-4" />
                                )}
                                {preparing > 0 ? "Fetching" : "Download"}
                            </Button>
                        </div>
                    ) : null}
                </DialogHeader>
                <div className="flex min-h-0 flex-1">
                    <div className="relative flex min-h-0 min-w-0 flex-1">
                        <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-surface/40">
                            {target ? (
                                // Keyed on the file, so stepping to the next one
                                // starts its viewer fresh rather than carrying
                                // the last one's page, scroll or zoom.
                                <FilePreview
                                    key={`${target.connectionId ?? ""}:${target.path}`}
                                    target={target}
                                    urlFor={urlFor}
                                    token={token}
                                    readOnly={readOnly}
                                    onSaved={onSaved}
                                />
                            ) : null}
                        </div>
                        {/* The same two moves at the edges of the file, where a
                            pointer already is, the way every mail client draws
                            them. */}
                        {canBack ? (
                            <button
                                type="button"
                                // The header's pair is the one a keyboard and a
                                // screen reader reach; these are for the pointer.
                                tabIndex={-1}
                                aria-hidden
                                aria-label="Previous file"
                                title="Previous file"
                                className="absolute left-3 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-elevated/90 text-foreground shadow-modal hover:bg-elevated"
                                onClick={() => stepping?.onStep(-1)}
                            >
                                <ChevronLeft className="size-5 shrink-0" aria-hidden />
                            </button>
                        ) : null}
                        {canForward ? (
                            <button
                                type="button"
                                // The header's pair is the one a keyboard and a
                                // screen reader reach; these are for the pointer.
                                tabIndex={-1}
                                aria-hidden
                                aria-label="Next file"
                                title="Next file"
                                className="absolute right-3 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-elevated/90 text-foreground shadow-modal hover:bg-elevated"
                                onClick={() => stepping?.onStep(1)}
                            >
                                <ChevronRight className="size-5 shrink-0" aria-hidden />
                            </button>
                        ) : null}
                    </div>
                    {target ? (
                        <aside className="hidden w-56 shrink-0 flex-col gap-2 border-l border-border p-4 text-sm md:flex">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Properties
                            </p>
                            <div className="flex justify-between gap-2">
                                <span className="text-muted-foreground">Type</span>
                                <span>
                                    {extension ? `${extension.toUpperCase()} file` : "File"}
                                </span>
                            </div>
                            {target.size !== undefined ? (
                                <div className="flex justify-between gap-2">
                                    <span className="text-muted-foreground">Size</span>
                                    <span>{formatBytes(BigInt(target.size))}</span>
                                </div>
                            ) : null}
                            {target.modifiedAt ? (
                                <div className="flex flex-col gap-0.5">
                                    <span className="text-muted-foreground">Modified</span>
                                    <span>{format.dateTime(target.modifiedAt)}</span>
                                </div>
                            ) : null}
                            <div className="flex flex-col gap-0.5">
                                <span className="text-muted-foreground">Location</span>
                                <span className="break-all">
                                    {target.locationLabel ??
                                        `/${target.path.split("/").slice(0, -1).join("/")}`}
                                </span>
                            </div>
                        </aside>
                    ) : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}
