"use client";

/**
 * The PDF surface: pages, thumbnails, outline, search, annotation tools and the
 * save actions, all in the dashboard rather than in whatever viewer the browser
 * happens to ship.
 *
 * pdf.js does the rendering and the editing; PDFSlick is the store and the
 * React components around it, so page number, zoom, layout, outline and
 * thumbnails are state this screen can read instead of viewer internals it
 * would have to reach into. Saving asks pdf.js to serialize the document, which
 * writes real PDF annotation objects and form values any other reader can open.
 *
 * Everything is same-origin: the worker, CMaps, standard fonts, ICC profiles,
 * wasm decoders and the annotation editor's own icons are served from public/,
 * staged at build time from the installed pdfjs-dist.
 */

import { Loader2 } from "lucide-react";
import { PdfTools } from "./pdf-tools";
import { ViewerError } from "./status";
import { PdfSearch } from "./pdf-search";
import { PdfSidebar } from "./pdf-sidebar";
import { PdfToolbar } from "./pdf-toolbar";
import type { ViewerTarget } from "./types";
import "@pdfslick/react/dist/pdf_viewer.css";
import { usePdfEdits } from "./pdf-annotate";
import { usePDFSlick } from "@pdfslick/react";
import { EditorActions } from "./editor-actions";
import type { PDFSlickOptions } from "@pdfslick/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnnotationEditorType, AnnotationMode, GlobalWorkerOptions } from "pdfjs-dist";

const ASSETS = "/pdfjs/";

// PDFSlick points the worker at a copy the bundler emits for it. Everything
// here is served from public/pdfjs instead, staged at build time from the
// installed pdfjs-dist, so the worker matches the CMaps, fonts and decoders
// beside it and nothing is ever fetched from a CDN.
GlobalWorkerOptions.workerSrc = `${ASSETS}pdf.worker.min.mjs`;

export default function PdfDocument({
    src,
    target,
    readOnly = false,
    onSaved
}: {
    src: string;
    target: ViewerTarget;
    readOnly?: boolean;
    onSaved?: (name: string) => void;
}) {
    const frameRef = useRef<HTMLDivElement>(null);
    const [progress, setProgress] = useState(0);
    const [searchOpen, setSearchOpen] = useState(false);
    // Wide enough for the pages to keep their width beside it: the panel opens
    // itself. A phone gets the pages and the button that reveals the rest.
    const [sidebarOpen, setSidebarOpen] = useState(
        () => window.matchMedia("(min-width: 768px)").matches
    );

    const options = useMemo<PDFSlickOptions>(
        () => ({
            filename: target.name,
            scaleValue: "page-width",
            thumbnailWidth: 132,
            annotationMode: readOnly ? AnnotationMode.ENABLE : AnnotationMode.ENABLE_STORAGE,
            // A reader who cannot write the file back is not given an editor to
            // draw in; a filled form it can never save is a dead end.
            annotationEditorMode: readOnly
                ? AnnotationEditorType.DISABLE
                : AnnotationEditorType.NONE,
            getDocumentParams: {
                cMapUrl: `${ASSETS}cmaps/`,
                cMapPacked: true,
                standardFontDataUrl: `${ASSETS}standard_fonts/`,
                wasmUrl: `${ASSETS}wasm/`,
                iccUrl: `${ASSETS}iccs/`
            },
            onProgress: ({ loaded, total }) => setProgress(total > 0 ? loaded / total : 0)
        }),
        [target.name, readOnly]
    );

    const { viewerRef, thumbsRef, usePDFSlickStore, PDFSlickViewer, error } = usePDFSlick(
        src,
        options
    );
    const pdfSlick = usePDFSlickStore((state) => state.pdfSlick);
    // The hook's own flag turns true even when the document failed to open -
    // PDFSlick reports the failure through onError and resolves anyway. The
    // store's flag is written only once pdf.js has the document, which is also
    // when the annotation editor exists to be switched on.
    const loaded = usePDFSlickStore((state) => state.isDocumentLoaded);
    const edits = usePdfEdits(readOnly ? null : pdfSlick, loaded);

    // PDFSlick keeps the document (and its worker) alive when the component
    // goes: opening a handful of files would leave a worker running for each.
    useEffect(() => {
        if (!pdfSlick) return;
        return () => {
            pdfSlick.unbindEvents();
            pdfSlick._cleanup();
            pdfSlick.document?.loadingTask.destroy();
        };
    }, [pdfSlick]);

    // Find inside the document rather than inside the page around it, but only
    // while the reader is actually in the viewer. Focus alone is not enough to
    // tell: a reader scrolling the pages with the wheel has never given the
    // viewer focus, and the dialog around it keeps hold of it.
    useEffect(() => {
        function onKeyDown(event: KeyboardEvent) {
            if (event.key !== "f" || !(event.ctrlKey || event.metaKey)) return;
            const frame = frameRef.current;
            if (!frame) return;
            if (!frame.contains(document.activeElement) && !frame.matches(":hover")) return;
            event.preventDefault();
            setSearchOpen(true);
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    function afterSave(name: string) {
        if (name === target.name) edits.markSaved();
        onSaved?.(name);
    }

    return (
        <div ref={frameRef} tabIndex={-1} className="flex h-[80vh] max-h-[80vh] flex-col">
            <PdfToolbar
                pdfSlick={pdfSlick}
                usePDFSlickStore={usePDFSlickStore}
                sidebarOpen={sidebarOpen}
                onSidebarToggle={() => setSidebarOpen((open) => !open)}
                searchOpen={searchOpen}
                onSearchToggle={() => setSearchOpen((open) => !open)}
                actions={
                    readOnly || !loaded ? null : (
                        <EditorActions
                            target={target}
                            dirty={edits.dirty}
                            exportAs={edits.exportAs}
                            onSaved={afterSave}
                        />
                    )
                }
            />
            {readOnly ? null : (
                <PdfTools
                    tool={edits.tool}
                    onSelect={edits.selectTool}
                    params={edits.params}
                    onParams={edits.updateParams}
                    disabled={!loaded}
                />
            )}
            {searchOpen ? (
                <PdfSearch pdfSlick={pdfSlick} onClose={() => setSearchOpen(false)} />
            ) : null}
            {error ? (
                <ViewerError>
                    This PDF could not be opened. It may be damaged or password-protected.
                </ViewerError>
            ) : (
                <div className="flex min-h-0 flex-1">
                    <PdfSidebar
                        open={sidebarOpen}
                        pdfSlick={pdfSlick}
                        thumbsRef={thumbsRef}
                        usePDFSlickStore={usePDFSlickStore}
                    />
                    <div className="relative min-h-0 flex-1 bg-background">
                        <PDFSlickViewer viewerRef={viewerRef} usePDFSlickStore={usePDFSlickStore} />
                        {loaded ? null : (
                            <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
                                <Loader2 className="size-4 animate-spin" />
                                {progress > 0 && progress < 1
                                    ? `Loading ${Math.round(progress * 100)}%`
                                    : "Loading preview..."}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
