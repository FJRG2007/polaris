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
import { useMemo, useRef, useState } from "react";
import * as flying from "@polaris/ui/image-flight";
import { useTranslations } from "@/components/i18n/i18n-provider";
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
import { StepControls, stepOfKey, useSwipeToStep } from "./viewer-stepper";
import type { ViewerTarget, ViewerUrlFor } from "./viewer/types";
import { startDownload, useDownloadsPending } from "@/lib/drive/downloads";
import { ChevronLeft, ChevronRight, Download, Loader2, Share2 } from "lucide-react";
import { ImageViewer, type ViewerLabels } from "@polaris/ui/image-viewer";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, cn } from "@polaris/ui";

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
    readOnly = false,
    allowDownload = true,
    from,
    fill = false
}: {
    target: ViewerTarget;
    onSaved?: (name: string) => void;
    urlFor?: ViewerUrlFor;
    /** The share this is being viewed through, when it is one. A presentation is
     *  rendered by the server, and that request needs the same pass the bytes
     *  came through - a share visitor has no session to authorise it. */
    token?: string;
    readOnly?: boolean;
    /** Whether the file may be saved from here. A view-only share link says no,
     *  and then no save is offered anywhere in the preview. */
    allowDownload?: boolean;
    /** Where an image grows from when it opens: its thumbnail's box, measured
     *  before the preview took the listing's place. Null fades it in place;
     *  left out, it simply appears. */
    from?: flying.Box | null;
    /** A picture fills the box it is in (a frame with a height of its own, like
     *  the dialog). Otherwise it gets a fixed share of the window, so stepping
     *  between pictures of different shapes never resizes the frame. */
    fill?: boolean;
}) {
    const src = (urlFor ?? driveByteUrl)(target, true);
    const kind = viewerKind(target.name);

    if (kind === "image") {
        return (
            <div
                data-preview-frame=""
                className={cn("w-full p-4", fill ? "h-full" : "h-[70vh] min-h-64")}
            >
                <PreviewPicture src={src} alt={target.name} from={from} />
            </div>
        );
    }
    if (kind === "video" || kind === "audio") {
        // The same address the toolbar's own save uses: served as a file rather
        // than to be played, which is the difference between saving it and
        // navigating to it.
        return (
            <MediaView
                src={src}
                kind={kind}
                download={allowDownload ? (urlFor ?? driveByteUrl)(target, false) : undefined}
            />
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
 * The image preview's picture, drawn by the viewer every picture in Polaris
 * opens in, so zoom, pan and fit answer here the way they do everywhere else.
 * Embedded: the header, stepping, Escape and the flight are Drive's own.
 *
 * It grows out of its thumbnail once it has a size. The flight is made by a
 * copy above the page, because the picture sits in a scrolling box that would
 * clip it on the way in; the real one waits hidden underneath and shows when
 * the copy lands. Once per opening: stepping keeps this mounted, so the next
 * picture swaps in place rather than opening again.
 */
function PreviewPicture({
    src,
    alt,
    from
}: {
    src: string;
    alt: string;
    from: flying.Box | null | undefined;
}) {
    const t = useTranslations("driveViewer");
    const flown = useRef(false);
    // Read when the first picture loads, which may be renders after `from`
    // was handed in.
    const fromRef = useRef(from);
    fromRef.current = from;
    const image = useMemo(() => ({ url: src, name: alt }), [src, alt]);
    const labels: ViewerLabels = {
        zoomIn: t("picture.zoomIn"),
        zoomOut: t("picture.zoomOut"),
        fit: t("picture.fit"),
        more: t("picture.more"),
        close: t("picture.close"),
        previous: t("viewer.previousFile"),
        next: t("viewer.nextFile"),
        position: (index, count) => t("viewer.position", { index, count })
    };
    return (
        <ImageViewer
            embedded
            image={image}
            onClose={() => undefined}
            labels={labels}
            onPictureLoad={(picture) => {
                const origin = fromRef.current;
                if (origin === undefined || flown.current || picture.offsetWidth < 1) return;
                flown.current = true;
                if (!flying.canFly(picture)) return;
                const at = flying.boxOf(picture);
                if (!origin) {
                    flying.growIn(picture, at, null);
                    return;
                }
                const copy = flying.pictureCopy(picture.currentSrc || src, at);
                picture.style.visibility = "hidden";
                const land = () => {
                    copy.remove();
                    picture.style.visibility = "";
                };
                flying.growIn(copy, at, origin).finished.then(land, land);
                // A tab in the background may never finish it.
                setTimeout(land, flying.OPEN_MS + 120);
            }}
        />
    );
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

export function FileViewer({
    target,
    onOpenChange,
    onShare,
    onSaved,
    urlFor,
    token,
    readOnly = false,
    allowDownload = true,
    steps,
    thumbnailFor
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
    /** Whether the file may be saved from here - see `FilePreview`. */
    allowDownload?: boolean;
    /** The share token this is opened through, when it is a public link. */
    token?: string;
    /** Several files opened together - see `ViewerSteps`. Nothing is drawn for one. */
    steps?: ViewerSteps;
    /** The thumbnail a file was opened from, while it is on the page: its picture
     *  grows out of it and shrinks back into it. Null when there is none, which
     *  fades the picture in place; left out, it simply appears. */
    thumbnailFor?: (target: ViewerTarget) => Element | null;
}) {
    const t = useTranslations("driveViewer");
    const content = useRef<HTMLDivElement>(null);
    const key = target ? `${target.connectionId ?? ""}:${target.path}` : null;
    // Measured on the render that opens the viewer, before the dialog covers the
    // thumbnail - see `nextOpening`.
    const [opening, setOpening] = useState<flying.Opening | null>(null);
    const next = thumbnailFor
        ? flying.nextOpening(opening, key, () =>
              target ? flying.visibleBox(thumbnailFor(target), flying.viewportSize()) : null
          )
        : null;
    if (next !== opening) setOpening(next);
    const from = thumbnailFor && key !== null ? flying.openingFrom(next, key) : undefined;

    /** Closed: a picture shrinks back into its thumbnail on the way, as a copy,
     *  because the real one goes with the dialog. */
    function changeOpen(open: boolean) {
        const picture = content.current?.querySelector<HTMLImageElement>("[data-viewer-picture]");
        if (
            open ||
            !target ||
            !thumbnailFor ||
            !flying.canFly(picture) ||
            picture.offsetWidth < 1
        ) {
            onOpenChange(open);
            return;
        }
        const at = flying.boxOf(picture);
        const copy = flying.pictureCopy(picture.currentSrc || picture.src, at);
        picture.style.visibility = "hidden";
        const into = flying.visibleBox(thumbnailFor(target), flying.viewportSize());
        onOpenChange(false);
        void flying.shrinkOut(copy, at, into).then(() => copy.remove());
    }
    const format = useDisplayFormat();
    const byteUrl = urlFor ?? driveByteUrl;
    // Whether the server has answered the last request for bytes yet, so a file
    // on a slow share says it is coming - see `drive/downloads`.
    const preparing = useDownloadsPending();
    const extension = target ? extensionOf(target.name) : "";
    const stepping = steps && steps.count > 1 ? steps : null;
    const canBack = stepping !== null && stepping.index > 0;
    const canForward = stepping !== null && stepping.index < stepping.count - 1;
    // A sideways swipe steps too, on the kinds the arrow keys step on - the
    // reader of a shared album is most likely on a phone.
    const swipe = useSwipeToStep(target?.name ?? "", (by) => {
        if (stepping && (by < 0 ? canBack : canForward)) stepping.onStep(by);
    });

    return (
        <Dialog open={target !== null} onOpenChange={changeOpen}>
            <DialogContent
                ref={content}
                className="flex max-h-[90vh] max-w-6xl flex-col gap-0 overflow-hidden p-0"
                onKeyDown={(event) => {
                    if (!stepping) return;
                    const by = stepOfKey(event, stepping.index, stepping.count);
                    if (by === 0) return;
                    event.preventDefault();
                    stepping.onStep(by);
                }}
            >
                <DialogHeader className="flex flex-row items-center justify-between gap-3 px-4 py-3">
                    <DialogTitle className="min-w-0 truncate text-sm">{target?.name}</DialogTitle>
                    {target ? (
                        <div className="mr-8 flex shrink-0 items-center gap-2">
                            {stepping ? (
                                <StepControls
                                    index={stepping.index}
                                    count={stepping.count}
                                    onStep={stepping.onStep}
                                />
                            ) : null}
                            {onShare ? (
                                <Button size="sm" variant="ghost" onClick={() => onShare(target)}>
                                    <Share2 className="size-4" />
                                    {t("viewer.share")}
                                </Button>
                            ) : null}
                            {allowDownload ? (
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={preparing > 0}
                                    onClick={() =>
                                        startDownload(byteUrl(target, false), target.name)
                                    }
                                >
                                    {preparing > 0 ? (
                                        <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                        <Download className="size-4" />
                                    )}
                                    {preparing > 0 ? t("viewer.fetching") : t("viewer.download")}
                                </Button>
                            ) : null}
                        </div>
                    ) : null}
                </DialogHeader>
                <div className="flex min-h-0 flex-1">
                    <div className="relative flex min-h-0 min-w-0 flex-1">
                        <div
                            {...swipe}
                            className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-surface/40"
                        >
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
                                    allowDownload={allowDownload}
                                    onSaved={onSaved}
                                    from={from}
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
                                aria-label={t("viewer.previousFile")}
                                title={t("viewer.previousFile")}
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
                                aria-label={t("viewer.nextFile")}
                                title={t("viewer.nextFile")}
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
                                {t("viewer.properties")}
                            </p>
                            <div className="flex justify-between gap-2">
                                <span className="text-muted-foreground">{t("viewer.type")}</span>
                                <span>
                                    {extension
                                        ? t("viewer.kindFile", { kind: extension.toUpperCase() })
                                        : t("viewer.file")}
                                </span>
                            </div>
                            {target.size !== undefined ? (
                                <div className="flex justify-between gap-2">
                                    <span className="text-muted-foreground">
                                        {t("viewer.size")}
                                    </span>
                                    <span>{formatBytes(BigInt(target.size))}</span>
                                </div>
                            ) : null}
                            {target.modifiedAt ? (
                                <div className="flex flex-col gap-0.5">
                                    <span className="text-muted-foreground">
                                        {t("viewer.modified")}
                                    </span>
                                    <span>{format.dateTime(target.modifiedAt)}</span>
                                </div>
                            ) : null}
                            <div className="flex flex-col gap-0.5">
                                <span className="text-muted-foreground">
                                    {t("viewer.location")}
                                </span>
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
