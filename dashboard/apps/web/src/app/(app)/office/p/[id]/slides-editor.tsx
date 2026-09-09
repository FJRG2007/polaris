"use client";

/**
 * A presentation, being made.
 *
 * The model is `lib/office/deck.ts` and the reason it is Polaris' own is there:
 * no open-source web presentation editor is both complete and permissively
 * licensed to embed, and a deck is a small enough thing to model that porting
 * one from another framework would be more work than writing this.
 *
 * Slides down the left, one slide on the canvas, boxes dragged and typed into.
 * Everything is a fraction of the slide rather than a pixel, so a deck made on a
 * laptop is the same deck on a projector - the canvas multiplies and nothing
 * stored has ever heard of a screen size.
 *
 * Boxes merge one at a time, keyed by slide and box, exactly as shapes do on a
 * diagram: two people editing two boxes is two independent changes.
 */

import * as Y from "yjs";
import { Button, cn } from "@polaris/ui";
import * as deck from "@/lib/office/deck";
import { Copy, Play, Plus, Square, Trash2, Type, X } from "lucide-react";
import { useOfficeDocument } from "@/app/(app)/office/use-office-document";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";

const SLIDES = "slides";
const BOXES = "boxes";

export function SlidesEditor({
    documentId,
    content,
    editable
}: {
    documentId: string;
    content: number[] | null;
    editable: boolean;
}) {
    const { doc } = useOfficeDocument({ documentId, content, editable });
    const slides = useMemo(() => doc.getArray<deck.Slide>(SLIDES), [doc]);
    const boxes = useMemo(() => doc.getMap<deck.Box>(BOXES), [doc]);
    const version = useDocumentVersion(doc);

    const deckSlides = useMemo(() => slides.toArray(), [slides, version]);
    const [atIndex, setAtIndex] = useState(0);
    const [chosen, setChosen] = useState("");
    const [presenting, setPresenting] = useState(false);

    const slide = deckSlides[Math.min(atIndex, deckSlides.length - 1)] ?? null;
    const onSlide = useMemo(
        () => (slide ? deck.boxesOn(slide.id, new Map(boxes.entries())) : []),
        [slide, boxes, version]
    );

    const addSlide = useCallback(() => {
        doc.transact(() => {
            const id = crypto.randomUUID();
            slides.push([{ id, notes: "" }]);
            // Never a blank rectangle: a slide with nothing on it and no obvious
            // way in is where a deck stops being made.
            boxes.set(deck.boxKey(id, "title"), deck.titleBox("title"));
        });
        setAtIndex(deckSlides.length);
    }, [boxes, deckSlides.length, doc, slides]);

    if (deckSlides.length === 0) {
        return (
            <div className="flex min-h-0 flex-1 items-center justify-center p-8">
                <div className="flex flex-col items-center gap-3 text-center">
                    <p className="text-[13px] font-medium">No slides yet</p>
                    <p className="max-w-sm text-[13px] text-muted-foreground">
                        Everything on a slide is placed as a fraction of it, so what you make here
                        looks the same on a projector as it does now.
                    </p>
                    {editable ? (
                        <Button onClick={addSlide}>
                            <Plus className="size-4 shrink-0" aria-hidden />
                            Add the first slide
                        </Button>
                    ) : null}
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-0 flex-1">
            {/* The slides. A column of them rather than a strip: a deck is read
                top to bottom in every tool that makes one. */}
            <aside className="hidden w-44 shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain border-r border-border p-2 sm:flex">
                {deckSlides.map((one, index) => (
                    <button
                        key={one.id}
                        type="button"
                        onClick={() => {
                            setAtIndex(index);
                            setChosen("");
                        }}
                        aria-current={index === atIndex ? "true" : undefined}
                        className={cn(
                            "relative aspect-video w-full overflow-hidden rounded-md border text-left transition-colors",
                            index === atIndex
                                ? "border-primary ring-1 ring-primary"
                                : "border-border hover:border-border-strong"
                        )}
                    >
                        <Canvas boxes={deck.boxesOn(one.id, new Map(boxes.entries()))} />
                        <span className="absolute bottom-1 left-1 rounded bg-background/80 px-1 text-[10px] text-muted-foreground">
                            {index + 1}
                        </span>
                    </button>
                ))}
                {editable ? (
                    <Button variant="secondary" size="sm" onClick={addSlide}>
                        <Plus className="size-4 shrink-0" aria-hidden />
                        Slide
                    </Button>
                ) : null}
            </aside>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
                    {editable ? (
                        <>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => slide && addBox(doc, slide.id, "text")}
                            >
                                <Type className="size-4 shrink-0" aria-hidden />
                                Text
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => slide && addBox(doc, slide.id, "shape")}
                            >
                                <Square className="size-4 shrink-0" aria-hidden />
                                Shape
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={!chosen}
                                onClick={() => slide && chosen && removeBox(doc, slide.id, chosen)}
                            >
                                <Trash2 className="size-4 shrink-0" aria-hidden />
                                Remove
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => slide && duplicateSlide(doc, slide.id, atIndex)}
                            >
                                <Copy className="size-4 shrink-0" aria-hidden />
                                Duplicate slide
                            </Button>
                        </>
                    ) : null}
                    <Button
                        variant="secondary"
                        size="sm"
                        className="ml-auto"
                        onClick={() => setPresenting(true)}
                    >
                        <Play className="size-4 shrink-0" aria-hidden />
                        Present
                    </Button>
                </div>

                <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto overscroll-contain bg-muted/30 p-4">
                    <div className="w-full max-w-4xl">
                        <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-background shadow-sm">
                            <Canvas
                                boxes={onSlide}
                                chosen={chosen}
                                editable={editable}
                                onChoose={setChosen}
                                onMove={(box, frame) =>
                                    slide && moveBox(doc, slide.id, box, frame)
                                }
                                onText={(box, text) => slide && setText(doc, slide.id, box, text)}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {presenting ? (
                <Present
                    slides={deckSlides}
                    boxes={new Map(boxes.entries())}
                    from={atIndex}
                    onClose={() => setPresenting(false)}
                />
            ) : null}
        </div>
    );
}

/**
 * One slide, drawn.
 *
 * The same component for the thumbnail, the canvas and the full screen, which is
 * the whole reason positions are fractions: three sizes, one drawing, and no
 * chance of the thumbnail disagreeing with the slide.
 */
function Canvas({
    boxes,
    chosen = "",
    editable = false,
    onChoose,
    onMove,
    onText
}: {
    boxes: readonly deck.Box[];
    chosen?: string;
    editable?: boolean;
    onChoose?: (id: string) => void;
    onMove?: (box: deck.Box, frame: deck.BoxFrame) => void;
    onText?: (box: deck.Box, text: string) => void;
}) {
    const host = useRef<HTMLDivElement | null>(null);

    return (
        <div ref={host} className="absolute inset-0">
            {boxes.map((box) => (
                <div
                    key={box.id}
                    role={editable ? "button" : undefined}
                    tabIndex={editable ? 0 : undefined}
                    onPointerDown={(event) => {
                        if (!editable || !onMove) return;
                        onChoose?.(box.id);
                        const box$ = host.current?.getBoundingClientRect();
                        if (!box$) return;
                        const fromX = event.clientX;
                        const fromY = event.clientY;
                        const start = { x: box.x, y: box.y, w: box.w, h: box.h };
                        const move = (at: PointerEvent): void => {
                            onMove(box, {
                                ...start,
                                x: start.x + (at.clientX - fromX) / box$.width,
                                y: start.y + (at.clientY - fromY) / box$.height
                            });
                        };
                        const up = (): void => {
                            window.removeEventListener("pointermove", move);
                            window.removeEventListener("pointerup", up);
                        };
                        window.addEventListener("pointermove", move);
                        window.addEventListener("pointerup", up);
                    }}
                    className={cn(
                        "absolute overflow-hidden",
                        editable && "cursor-move",
                        chosen === box.id && "outline outline-2 outline-primary"
                    )}
                    style={{
                        left: `${box.x * 100}%`,
                        top: `${box.y * 100}%`,
                        width: `${box.w * 100}%`,
                        height: `${box.h * 100}%`,
                        background: box.kind === "shape" ? box.fill || "#7c5cff" : undefined,
                        borderRadius: box.kind === "shape" ? "0.5rem" : undefined
                    }}
                >
                    {box.kind === "text" ? (
                        <div
                            // Typed into in place. A dialog to change a line of
                            // text on a slide is the thing that makes people stop
                            // fixing their slides.
                            contentEditable={editable && chosen === box.id}
                            suppressContentEditableWarning
                            onBlur={(event) => onText?.(box, event.currentTarget.textContent ?? "")}
                            className={cn(
                                "h-full w-full outline-none",
                                box.align === "center" && "text-center",
                                box.align === "right" && "text-right"
                            )}
                            style={{
                                // A fraction of the slide's height, so words scale
                                // with it. `cqh` measures the container, which is
                                // the slide.
                                fontSize: `${box.size * 100}cqh`,
                                color: box.color || undefined
                            }}
                        >
                            {box.text}
                        </div>
                    ) : null}
                    {box.kind === "image" && box.src ? (
                        // eslint-disable-next-line @next/next/no-img-element -- one picture per box, no loader wanted
                        <img src={box.src} alt="" className="h-full w-full object-contain" />
                    ) : null}
                </div>
            ))}
        </div>
    );
}

/** The deck, full screen. Arrow keys and Escape, which is the whole interface
 *  anybody uses while presenting. */
function Present({
    slides,
    boxes,
    from,
    onClose
}: {
    slides: readonly deck.Slide[];
    boxes: ReadonlyMap<string, deck.Box>;
    from: number;
    onClose: () => void;
}) {
    const [at, setAt] = useState(from);
    const slide = slides[at];
    return (
        <div
            role="dialog"
            aria-label="Presenting"
            tabIndex={-1}
            autoFocus
            onKeyDown={(event) => {
                if (event.key === "Escape") onClose();
                if (event.key === "ArrowRight" || event.key === " ") {
                    setAt((one) => Math.min(slides.length - 1, one + 1));
                }
                if (event.key === "ArrowLeft") setAt((one) => Math.max(0, one - 1));
            }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black outline-none"
        >
            <Button
                variant="ghost"
                size="icon"
                aria-label="Stop presenting"
                title="Stop presenting"
                className="absolute right-3 top-3 text-white"
                onClick={onClose}
            >
                <X className="size-5 shrink-0" aria-hidden />
            </Button>
            <div className="relative aspect-video w-full max-w-[95vw] bg-background [container-type:size] sm:max-h-[90vh]">
                {slide ? <Canvas boxes={deck.boxesOn(slide.id, boxes)} /> : null}
            </div>
            <p className="mt-3 text-[12px] text-white/60">
                {at + 1} of {slides.length}
            </p>
        </div>
    );
}

function addBox(doc: Y.Doc, slideId: string, kind: deck.BoxKind): void {
    const id = crypto.randomUUID();
    doc.getMap<deck.Box>(BOXES).set(deck.boxKey(slideId, id), deck.newBox(kind, id));
}

function removeBox(doc: Y.Doc, slideId: string, boxId: string): void {
    doc.getMap<deck.Box>(BOXES).delete(deck.boxKey(slideId, boxId));
}

function moveBox(doc: Y.Doc, slideId: string, box: deck.Box, frame: deck.BoxFrame): void {
    // Clamped rather than refused: dragging a box off the edge is something
    // people do constantly, and "it stopped at the edge" is the useful answer.
    const kept = deck.clampFrame(frame);
    doc
        .getMap<deck.Box>(BOXES)
        .set(deck.boxKey(slideId, box.id), { ...box, ...kept, version: box.version + 1 });
}

function setText(doc: Y.Doc, slideId: string, box: deck.Box, text: string): void {
    if (text === box.text) return;
    doc
        .getMap<deck.Box>(BOXES)
        .set(deck.boxKey(slideId, box.id), { ...box, text, version: box.version + 1 });
}

function duplicateSlide(doc: Y.Doc, slideId: string, index: number): void {
    doc.transact(() => {
        const slides = doc.getArray<deck.Slide>(SLIDES);
        const boxes = doc.getMap<deck.Box>(BOXES);
        const id = crypto.randomUUID();
        slides.insert(index + 1, [{ id, notes: "" }]);
        for (const box of deck.boxesOn(slideId, new Map(boxes.entries()))) {
            const copy = crypto.randomUUID();
            boxes.set(deck.boxKey(id, copy), { ...box, id: copy, version: 1 });
        }
    });
}

/** A number that changes whenever the document does, so the deck redraws. */
function useDocumentVersion(doc: Y.Doc): number {
    return useSyncExternalStore(
        useCallback(
            (onChange: () => void) => {
                doc.on("update", onChange);
                return () => doc.off("update", onChange);
            },
            [doc]
        ),
        () => doc.store.clients.size,
        () => 0
    );
}
