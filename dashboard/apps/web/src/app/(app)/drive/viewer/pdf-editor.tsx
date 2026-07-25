"use client";

/**
 * PDF editing on top of pdf.js. The document renders through the viewer
 * component with its annotation editor layer enabled, so the toolbar exposes
 * what pdf.js itself supports - free text, freehand drawing (signatures),
 * highlights and image stamps - on top of fillable form fields. Saving asks
 * pdf.js to serialize the document, which writes real PDF annotation objects and
 * form values that any other reader can open and keep editing.
 *
 * Everything is same-origin: the worker, CMaps, standard fonts, ICC profiles and
 * wasm decoders are served from /pdfjs (staged at build time from pdfjs-dist).
 */

import "pdfjs-dist/web/pdf_viewer.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Highlighter, ImagePlus, MousePointer2, PenLine, Type } from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { Button, cn } from "@polaris/ui";
import { EditorActions } from "./editor-actions";
import { Loading, ViewerError } from "./status";
import type { ViewerTarget } from "./types";

const ASSETS = "/pdfjs/";

type EditorTool = "none" | "text" | "draw" | "highlight" | "image";

const TOOLS: { id: EditorTool; label: string; icon: typeof Type }[] = [
    { id: "none", label: "Select", icon: MousePointer2 },
    { id: "text", label: "Text", icon: Type },
    { id: "draw", label: "Draw", icon: PenLine },
    { id: "highlight", label: "Highlight", icon: Highlighter },
    { id: "image", label: "Image", icon: ImagePlus }
];

export default function PdfEditor({
    src,
    target,
    onSaved,
    onExit
}: {
    src: string;
    target: ViewerTarget;
    onSaved?: (name: string) => void;
    onExit: () => void;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewerRef = useRef<PDFViewer | null>(null);
    const documentRef = useRef<PDFDocumentProxy | null>(null);
    // pdf.js' editor-mode constants, captured once the library is loaded.
    const modesRef = useRef<Record<EditorTool, number> | null>(null);
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const [tool, setTool] = useState<EditorTool>("none");
    const [dirty, setDirty] = useState(false);

    useEffect(() => {
        let alive = true;
        let task: PDFDocumentLoadingTask | null = null;
        void (async () => {
            try {
                const [pdfjs, viewerModule] = await Promise.all([
                    import("pdfjs-dist"),
                    import("pdfjs-dist/web/pdf_viewer.mjs")
                ]);
                if (!alive || !containerRef.current) return;
                pdfjs.GlobalWorkerOptions.workerSrc = `${ASSETS}pdf.worker.min.mjs`;
                modesRef.current = {
                    none: pdfjs.AnnotationEditorType.NONE,
                    text: pdfjs.AnnotationEditorType.FREETEXT,
                    draw: pdfjs.AnnotationEditorType.INK,
                    highlight: pdfjs.AnnotationEditorType.HIGHLIGHT,
                    image: pdfjs.AnnotationEditorType.STAMP
                };
                const eventBus = new viewerModule.EventBus();
                const linkService = new viewerModule.PDFLinkService({ eventBus });
                const viewer = new viewerModule.PDFViewer({
                    container: containerRef.current,
                    eventBus,
                    linkService,
                    // ENABLE_STORAGE renders interactive form fields and keeps what is
                    // typed into them, which is what saveDocument() writes back.
                    annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE,
                    annotationEditorMode: pdfjs.AnnotationEditorType.NONE
                });
                linkService.setViewer(viewer);
                eventBus.on("pagesinit", () => {
                    viewer.currentScaleValue = "page-width";
                });
                // A drawing is only stored once the tool is left, so this is what
                // makes Save light up while a stroke is still in progress.
                eventBus.on("editingstateschanged", (event: { details?: unknown }) => {
                    const details = event.details as { hasSomethingToUndo?: boolean } | undefined;
                    if (details?.hasSomethingToUndo) setDirty(true);
                });
                task = pdfjs.getDocument({
                    url: src,
                    cMapUrl: `${ASSETS}cmaps/`,
                    cMapPacked: true,
                    standardFontDataUrl: `${ASSETS}standard_fonts/`,
                    wasmUrl: `${ASSETS}wasm/`,
                    iccUrl: `${ASSETS}iccs/`
                });
                const loaded = await task.promise;
                if (!alive) return;
                // Fires for both a stored annotation edit and a filled form field.
                const storage = loaded.annotationStorage as unknown as {
                    onSetModified: (() => void) | null;
                };
                storage.onSetModified = () => setDirty(true);
                viewer.setDocument(loaded);
                linkService.setDocument(loaded);
                viewerRef.current = viewer;
                documentRef.current = loaded;
                setStatus("ready");
            } catch {
                if (alive) setStatus("error");
            }
        })();
        return () => {
            alive = false;
            viewerRef.current?.cleanup();
            viewerRef.current = null;
            documentRef.current = null;
            // Destroying the loading task tears the document and its worker down.
            void task?.destroy();
        };
    }, [src]);

    function selectTool(next: EditorTool) {
        const viewer = viewerRef.current;
        const modes = modesRef.current;
        if (!viewer || !modes) return;
        setTool(next);
        viewer.annotationEditorMode = { mode: modes[next] };
    }

    /**
     * Leave the active tool so an in-progress drawing is committed, and let the
     * commit finish rendering: pdf.js only serializes a drawing once that has
     * happened, so saving straight away would silently drop the last stroke.
     */
    const commitEditing = useCallback(async () => {
        const viewer = viewerRef.current;
        const modes = modesRef.current;
        if (!viewer || !modes || viewer.annotationEditorMode.mode === modes.none) return;
        viewer.annotationEditorMode = { mode: modes.none };
        setTool("none");
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, []);

    const exportAs = useCallback(async (): Promise<Blob> => {
        const pdf = documentRef.current;
        if (!pdf) throw new Error("document not loaded");
        await commitEditing();
        const bytes = await pdf.saveDocument();
        return new Blob([bytes], { type: "application/pdf" });
    }, [commitEditing]);

    /** Overwriting makes the current state the stored one; a copy leaves it pending. */
    function afterSave(name: string) {
        if (name === target.name) {
            documentRef.current?.annotationStorage.resetModified();
            setDirty(false);
        }
        onSaved?.(name);
    }

    return (
        <div className="flex max-h-[80vh] flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                    {TOOLS.map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            type="button"
                            title={label}
                            disabled={status !== "ready"}
                            onClick={() => selectTool(id)}
                            className={cn(
                                "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors hover:bg-muted disabled:opacity-50",
                                tool === id ? "bg-muted font-medium" : "text-muted-foreground"
                            )}
                        >
                            <Icon className="size-4" />
                            {label}
                        </button>
                    ))}
                </div>
                <div className="ml-auto flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={onExit}>
                        Close editor
                    </Button>
                    {status === "ready" ? (
                        <EditorActions
                            target={target}
                            dirty={dirty}
                            exportAs={exportAs}
                            onSaved={afterSave}
                        />
                    ) : null}
                </div>
            </div>
            {status === "error" ? (
                <ViewerError>This PDF could not be opened for editing.</ViewerError>
            ) : null}
            <div className="relative h-[75vh] w-full">
                {status === "loading" ? (
                    <div className="absolute inset-0 z-10 bg-surface/40">
                        <Loading />
                    </div>
                ) : null}
                <div ref={containerRef} className="absolute inset-0 overflow-auto">
                    <div className="pdfViewer" />
                </div>
            </div>
        </div>
    );
}
