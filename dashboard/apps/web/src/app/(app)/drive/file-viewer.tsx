"use client";

/**
 * In-dashboard file viewer. `FilePreview` renders a file's bytes by type and the
 * `FileViewer` modal wraps it for the contexts that have nowhere to put it
 * inline (a public share). The Drive explorer embeds `FilePreview` directly.
 * By type: images natively, audio/video through a Polaris-themed Plyr, PDFs in
 * the browser's native viewer (with pdf.js behind an Edit mode), spreadsheets/CSV in
 * an editable grid, .docx read-only through mammoth, .pptx read-only as scaled
 * slides, source files as editable highlighted code, and anything else as
 * editable plain text (Notepad-style), binary or oversized files read-only.
 * Each viewer lives in ./viewer and pulls its heavy library in dynamically, so
 * nothing runs during SSR and a library only loads when a file of that type is
 * opened. Bytes are streamed from the drive route with an inline disposition
 * (Range-enabled, so media scrubbing works) and stay same-origin, so no external
 * assets are ever fetched.
 */

import { Download, Share2 } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@polaris/ui";
import { extensionOf } from "./file-categories";
import { CodeView } from "./viewer/code-view";
import { languageForFile } from "@/lib/code-language";
import { DocView } from "./viewer/doc-view";
import { MarkdownView } from "./viewer/markdown-view";
import { MediaView } from "./viewer/media-view";
import { PdfView } from "./viewer/pdf-view";
import { PptxView } from "./viewer/pptx-view";
import { SheetEditor } from "./viewer/sheet-editor";
import { PlainTextEditor } from "./viewer/text-editor";
import type { ViewerKind, ViewerTarget, ViewerUrlFor } from "./viewer/types";
import { useDisplayFormat } from "@/components/display-format";

export type { ViewerTarget, ViewerUrlFor, ViewerKind } from "./viewer/types";

const IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif", "ico"]);
const VIDEO = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO = new Set(["mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "opus"]);
const SHEET = new Set(["xlsx", "xls", "csv", "ods", "tsv"]);
const DOC = new Set(["docx"]);
const SLIDES = new Set(["pptx", "ppsx", "potx"]);
const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd"]);

/**
 * Which viewer renders a file by its extension. A file the highlighter has a
 * grammar for opens as code; anything without a richer viewer falls back to
 * "text" - the Notepad-style editor opens it as plain text.
 */
export function viewerKind(name: string): ViewerKind {
    const ext = extensionOf(name);
    if (IMAGE.has(ext)) return "image";
    if (VIDEO.has(ext)) return "video";
    if (AUDIO.has(ext)) return "audio";
    if (ext === "pdf") return "pdf";
    if (SHEET.has(ext)) return "sheet";
    if (DOC.has(ext)) return "doc";
    if (SLIDES.has(ext)) return "slides";
    if (MARKDOWN.has(ext)) return "markdown";
    if (languageForFile(name)) return "code";
    return "text";
}

/** Whether a file can be opened in the viewer (drives the click behavior). */
export function isViewable(name: string): boolean {
    return viewerKind(name) !== "none";
}

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
    readOnly = false
}: {
    target: ViewerTarget;
    onSaved?: (name: string) => void;
    urlFor?: ViewerUrlFor;
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
    if (kind === "video" || kind === "audio") return <MediaView src={src} kind={kind} />;
    if (kind === "pdf") return <PdfView src={src} target={target} readOnly={readOnly} onSaved={onSaved} />;
    if (kind === "sheet")
        return <SheetEditor src={src} target={target} readOnly={readOnly} onSaved={onSaved} />;
    if (kind === "doc") return <DocView src={src} />;
    if (kind === "slides") return <PptxView src={src} />;
    if (kind === "markdown")
        return <MarkdownView src={src} target={target} readOnly={readOnly} onSaved={onSaved} />;
    if (kind === "code")
        return <CodeView src={src} target={target} readOnly={readOnly} onSaved={onSaved} />;
    return <PlainTextEditor src={src} target={target} readOnly={readOnly} onSaved={onSaved} />;
}

export function FileViewer({
    target,
    onOpenChange,
    onShare,
    onSaved,
    urlFor,
    readOnly = false
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
}) {
    const format = useDisplayFormat();
    const byteUrl = urlFor ?? driveByteUrl;
    const extension = target ? extensionOf(target.name) : "";

    return (
        <Dialog open={target !== null} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[90vh] w-full max-w-6xl flex-col gap-0 overflow-hidden p-0">
                <DialogHeader className="flex flex-row items-center justify-between gap-3 px-4 py-3">
                    <DialogTitle className="min-w-0 truncate text-sm">{target?.name}</DialogTitle>
                    {target ? (
                        <div className="mr-8 flex shrink-0 items-center gap-2">
                            {onShare ? (
                                <Button size="sm" variant="ghost" onClick={() => onShare(target)}>
                                    <Share2 className="size-4" />
                                    Share
                                </Button>
                            ) : null}
                            <Button asChild size="sm" variant="secondary">
                                <a href={byteUrl(target, false)} download={target.name}>
                                    <Download className="size-4" />
                                    Download
                                </a>
                            </Button>
                        </div>
                    ) : null}
                </DialogHeader>
                <div className="flex min-h-0 flex-1">
                    <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-surface/40">
                        {target ? (
                            <FilePreview
                                target={target}
                                urlFor={urlFor}
                                readOnly={readOnly}
                                onSaved={onSaved}
                            />
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
