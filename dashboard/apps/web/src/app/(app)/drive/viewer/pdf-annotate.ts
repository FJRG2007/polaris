"use client";

/**
 * Annotating a PDF: which tools are offered, what each one draws with, and when
 * the document has something worth writing back.
 *
 * The tools are the ones pdf.js itself implements - free text, freehand drawing
 * (a signature), text highlights and image stamps - on top of the fillable form
 * fields the document already carries. Saving asks pdf.js to serialize, which
 * writes real PDF annotation objects and form values that any other reader can
 * open and keep editing.
 */

import type { PDFSlick } from "@pdfslick/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnnotationEditorParamsType, AnnotationEditorType } from "pdfjs-dist";
import { Highlighter, ImagePlus, MousePointer2, PenLine, Type } from "lucide-react";

export type EditorTool = "none" | "text" | "draw" | "highlight" | "image";

export const TOOLS: { id: EditorTool; label: string; icon: typeof Type }[] = [
    { id: "none", label: "Select", icon: MousePointer2 },
    { id: "text", label: "Text", icon: Type },
    { id: "draw", label: "Draw", icon: PenLine },
    { id: "highlight", label: "Highlight", icon: Highlighter },
    { id: "image", label: "Image", icon: ImagePlus }
];

const MODES: Record<EditorTool, number> = {
    none: AnnotationEditorType.NONE,
    text: AnnotationEditorType.FREETEXT,
    draw: AnnotationEditorType.INK,
    highlight: AnnotationEditorType.HIGHLIGHT,
    image: AnnotationEditorType.STAMP
};

/** Ink and text colors: dark by default, then the five a marker set carries. */
export const DRAW_COLORS = [
    { value: "#1c1c1e", label: "Black" },
    { value: "#e02424", label: "Red" },
    { value: "#f59e0b", label: "Amber" },
    { value: "#16a34a", label: "Green" },
    { value: "#2563eb", label: "Blue" },
    { value: "#7c3aed", label: "Violet" }
];

/** The highlighter colors pdf.js ships, which are the ones its editor renders best. */
export const HIGHLIGHT_COLORS = [
    { value: "#ffff98", label: "Yellow" },
    { value: "#53ffbc", label: "Green" },
    { value: "#80ebff", label: "Blue" },
    { value: "#ffcbe6", label: "Pink" },
    { value: "#ff4f5f", label: "Red" }
];

export interface ToolParams {
    textColor: string;
    textSize: number;
    drawColor: string;
    drawThickness: number;
    highlightColor: string;
    highlightThickness: number;
}

const DEFAULT_PARAMS: ToolParams = {
    textColor: "#1c1c1e",
    textSize: 10,
    drawColor: "#1c1c1e",
    drawThickness: 3,
    highlightColor: "#ffff98",
    highlightThickness: 12
};

/**
 * Push a tool's drawing settings at pdf.js. With nothing selected these become
 * the defaults new annotations are created with; with an annotation selected
 * they change that one, which is what a reader who clicked it expects.
 *
 * Only meaningful once a mode is in force - pdf.js drops params that arrive
 * before it knows which editor they belong to - so this always follows the mode.
 */
function applyParams(pdfSlick: PDFSlick, tool: EditorTool, params: ToolParams) {
    const { FREETEXT_COLOR, FREETEXT_SIZE, INK_COLOR, INK_THICKNESS } = AnnotationEditorParamsType;
    const { HIGHLIGHT_COLOR, HIGHLIGHT_THICKNESS } = AnnotationEditorParamsType;
    if (tool === "text")
        pdfSlick.setAnnotationEditorParams([
            { type: FREETEXT_COLOR, value: params.textColor },
            { type: FREETEXT_SIZE, value: params.textSize }
        ]);
    if (tool === "draw")
        pdfSlick.setAnnotationEditorParams([
            { type: INK_COLOR, value: params.drawColor },
            { type: INK_THICKNESS, value: params.drawThickness }
        ]);
    if (tool === "highlight")
        pdfSlick.setAnnotationEditorParams([
            { type: HIGHLIGHT_COLOR, value: params.highlightColor },
            { type: HIGHLIGHT_THICKNESS, value: params.highlightThickness }
        ]);
}

/**
 * The editing half of the PDF surface: the selected tool, its settings, whether
 * anything is pending, and the bytes to write.
 */
export function usePdfEdits(pdfSlick: PDFSlick | null, documentLoaded: boolean) {
    const [tool, setTool] = useState<EditorTool>("none");
    const [params, setParams] = useState<ToolParams>(DEFAULT_PARAMS);
    // pdf.js hashes the annotations and form values it would write; comparing
    // that against the hash of what is stored is what makes an edit that was
    // undone count as no change at all.
    const savedHash = useRef("");
    const [changed, setChanged] = useState(false);
    const [strokePending, setStrokePending] = useState(false);
    // A drawing is not stored until its tool is left, so while one is active an
    // undoable edit counts as a change the export will commit.
    const dirty = changed || (tool !== "none" && strokePending);

    const syncChanged = useCallback(() => {
        const pdf = pdfSlick?.document;
        if (!pdf) return;
        setChanged((pdf.annotationStorage.serializable.hash ?? "") !== savedHash.current);
    }, [pdfSlick]);

    useEffect(() => {
        const pdf = pdfSlick?.document;
        if (!pdfSlick || !pdf || !documentLoaded) return;
        savedHash.current = pdf.annotationStorage.serializable.hash ?? "";
        // Fires for both a stored annotation edit and a filled form field, but
        // only for the first one until the modified flag is cleared - so clear it
        // here to keep being told about every later change.
        const storage = pdf.annotationStorage as unknown as { onSetModified: (() => void) | null };
        storage.onSetModified = () => {
            pdf.annotationStorage.resetModified();
            syncChanged();
        };
        const onEditing = (event: unknown) => {
            const details = (event as { details?: { hasSomethingToUndo?: boolean } }).details;
            setStrokePending(Boolean(details?.hasSomethingToUndo));
            syncChanged();
            // Committing an editor finishes over the next frames; re-check once
            // it has, so the stored state decides on its own.
            requestAnimationFrame(() => requestAnimationFrame(syncChanged));
        };
        pdfSlick.on("editingstateschanged", onEditing);
        return () => {
            pdfSlick.off("editingstateschanged", onEditing);
            storage.onSetModified = null;
        };
    }, [pdfSlick, documentLoaded, syncChanged]);

    const selectTool = useCallback(
        (next: EditorTool) => {
            setTool(next);
            if (!pdfSlick) return;
            pdfSlick.setAnnotationEditorMode(MODES[next]);
            applyParams(pdfSlick, next, params);
        },
        [pdfSlick, params]
    );

    const updateParams = useCallback(
        (patch: Partial<ToolParams>) => {
            setParams((current) => {
                const next = { ...current, ...patch };
                if (pdfSlick) applyParams(pdfSlick, tool, next);
                return next;
            });
        },
        [pdfSlick, tool]
    );

    /**
     * Leave the active tool so an in-progress drawing is committed, and let the
     * commit finish rendering: pdf.js only serializes a drawing once that has
     * happened, so saving straight away would silently drop the last stroke.
     */
    const commitEditing = useCallback(async () => {
        if (!pdfSlick || pdfSlick.viewer.annotationEditorMode.mode === MODES.none) return;
        pdfSlick.setAnnotationEditorMode(MODES.none);
        setTool("none");
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, [pdfSlick]);

    const exportAs = useCallback(async (): Promise<Blob> => {
        const pdf = pdfSlick?.document;
        if (!pdf) throw new Error("document not loaded");
        await commitEditing();
        const bytes = await pdf.saveDocument();
        return new Blob([bytes], { type: "application/pdf" });
    }, [pdfSlick, commitEditing]);

    /** Overwriting makes the current state the stored one; a copy leaves it pending. */
    const markSaved = useCallback(() => {
        const pdf = pdfSlick?.document;
        if (!pdf) return;
        savedHash.current = pdf.annotationStorage.serializable.hash ?? "";
        pdf.annotationStorage.resetModified();
        setChanged(false);
        setStrokePending(false);
    }, [pdfSlick]);

    return { tool, selectTool, params, updateParams, dirty, exportAs, markSaved };
}
