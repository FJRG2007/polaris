"use client";

/**
 * A presentation, being made.
 *
 * The model is `lib/office/deck.ts` and the reason it is Polaris' own is there:
 * no open-source web presentation editor is both complete and permissively
 * licensed to embed, and a deck is a small enough thing to model that porting
 * one from another framework would be more work than writing this.
 *
 * Slides down the left, one slide on the canvas, boxes dragged, resized and
 * typed into (`slide-canvas.tsx`). Everything is a fraction of the slide rather
 * than a pixel, so a deck made on a laptop is the same deck on a projector - the
 * canvas multiplies and nothing stored has ever heard of a screen size.
 *
 * Boxes merge one at a time, keyed by slide and box, exactly as shapes do on a
 * diagram: two people editing two boxes is two independent changes. Every
 * change goes through `deck-edits.ts`, which is also what undo takes back.
 */

import * as deck from "@/lib/office/deck";
import * as edits from "./deck-edits";
import { SlideDrawing, SlideStage } from "./slide-canvas";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useOfficeDocument } from "@/app/(app)/office/use-office-document";
import { ShortcutsDialog } from "@/components/shortcuts/shortcuts-dialog";
import { Button, cn, matchShortcut, shortcutPressed } from "@polaris/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    Copy,
    CopyPlus,
    Keyboard,
    Play,
    Plus,
    Redo2,
    Square,
    Trash2,
    Type,
    Undo2,
    X
} from "lucide-react";

/** Every key the editor answers to, in the order a press is tried. */
const KEYS = [
    "office.slides.undo",
    "office.slides.redo",
    "office.slides.duplicate",
    "office.slides.delete",
    "office.slides.edit",
    "office.slides.deselect",
    "office.slides.nudge",
    "office.slides.nudgeFar",
    "office.slides.present",
    "office.slides.help"
] as const;

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0]
};

/** Whether a press or a paste belongs to a field being typed in, which keeps
 *  its own keys - Delete deletes a letter there, never the box. */
function typingIn(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "INPUT";
}

function onControl(target: EventTarget | null): boolean {
    if (!(target instanceof Element) || target.closest("[data-box]")) return false;
    return (
        target.closest(
            "button, a[href], select, summary, [role=button], [role=tab], [role=menuitem], [role=option]"
        ) !== null
    );
}

export function SlidesEditor({
    documentId,
    content,
    editable
}: {
    documentId: string;
    content: number[] | null;
    editable: boolean;
}) {
    const t = useTranslations("office");
    const { doc } = useOfficeDocument({ documentId, content, editable });
    const version = edits.useDocumentVersion(doc);
    const history = edits.useDeckHistory(doc, editable);

    const deckSlides = useMemo(() => edits.slidesOf(doc).toArray(), [doc, version]);
    const bySlide = useMemo(
        () => deck.groupBySlide(new Map(edits.boxesOf(doc).entries())),
        [doc, version]
    );
    const [atIndex, setAtIndex] = useState(0);
    const [chosen, setChosen] = useState("");
    const [editing, setEditing] = useState("");
    const [presenting, setPresenting] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);
    const root = useRef<HTMLDivElement | null>(null);

    const at = Math.min(atIndex, deckSlides.length - 1);
    const slide = deckSlides[at] ?? null;
    const onSlide = useMemo(() => (slide ? (bySlide.get(slide.id) ?? []) : []), [bySlide, slide]);
    // What is chosen is read off the slide as it is now, so a box somebody else
    // just removed is not still offered to the toolbar.
    const chosenBox = onSlide.find((box) => box.id === chosen) ?? null;

    const goTo = useCallback((index: number) => {
        setAtIndex(index);
        setChosen("");
        setEditing("");
    }, []);

    const addSlide = useCallback(() => {
        edits.addSlide(doc, at + 1);
        goTo(at + 1);
    }, [at, doc, goTo]);

    const addBox = (kind: deck.BoxKind): void => {
        if (!slide) return;
        const id = edits.addBox(doc, slide.id, kind);
        setChosen(id);
        // A new text box is for typing into, straight away.
        setEditing(kind === "text" ? id : "");
    };

    const duplicateChosen = (): void => {
        if (!slide || !chosenBox) return;
        const copy = deck.copyOf(chosenBox, crypto.randomUUID());
        edits.placeBoxes(doc, slide.id, [copy]);
        setChosen(copy.id);
    };

    const removeChosen = (): void => {
        if (!slide || !chosenBox) return;
        edits.removeBoxes(doc, slide.id, [chosenBox.id]);
        setChosen("");
        setEditing("");
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        if (typingIn(event.target) || deckSlides.length === 0) return;
        const action = matchShortcut(event, KEYS);
        if (!action) return;
        const handled = ((): boolean => {
            switch (action) {
                case "office.slides.present":
                    setPresenting(true);
                    return true;
                case "office.slides.help":
                    setHelpOpen(true);
                    return true;
                case "office.slides.deselect":
                    if (!chosen) return false;
                    setChosen("");
                    return true;
            }
            if (!editable || !slide) return false;
            switch (action) {
                case "office.slides.undo":
                    history.undo();
                    return true;
                case "office.slides.redo":
                    history.redo();
                    return true;
            }
            if (!chosenBox || onControl(event.target)) return false;
            switch (action) {
                case "office.slides.duplicate":
                    duplicateChosen();
                    return true;
                case "office.slides.delete":
                    removeChosen();
                    return true;
                case "office.slides.edit":
                    if (chosenBox.kind !== "text") return false;
                    setEditing(chosenBox.id);
                    return true;
                case "office.slides.nudge":
                case "office.slides.nudgeFar": {
                    const [right, down] = ARROWS[event.key] ?? [0, 0];
                    edits.setFrame(
                        doc,
                        slide.id,
                        chosenBox.id,
                        deck.nudgeFrame(chosenBox, right, down, action === "office.slides.nudgeFar")
                    );
                    return true;
                }
            }
            return false;
        })();
        if (handled) event.preventDefault();
    };

    const onCopy = (event: ClipboardEvent, cut: boolean): void => {
        if (typingIn(event.target) || !chosenBox || !event.clipboardData) return;
        event.preventDefault();
        event.clipboardData.setData(deck.CLIPBOARD_TYPE, deck.writeClipboard([chosenBox]));
        // Words as words, for pasting into anything that is not a deck.
        if (chosenBox.text) event.clipboardData.setData("text/plain", chosenBox.text);
        if (cut && editable) removeChosen();
    };

    const onPaste = (event: ClipboardEvent): void => {
        if (typingIn(event.target) || !editable || !slide || !event.clipboardData) return;
        const boxes = event.clipboardData.getData(deck.CLIPBOARD_TYPE);
        let pasted = boxes ? deck.readClipboard(boxes, () => crypto.randomUUID()) : [];
        if (pasted.length === 0) {
            // Plain words pasted onto a slide become a text box holding them,
            // as they do in every deck editor.
            const words = event.clipboardData.getData("text/plain").trim().slice(0, 20_000);
            if (!words) return;
            pasted = [{ ...deck.newBox("text", crypto.randomUUID()), text: words }];
        }
        event.preventDefault();
        // Pasted where its original still is, a box steps down and right until
        // it is visibly a second one.
        const placed = pasted.map((box) => {
            let one = box;
            for (let step = 0; step < 20; step += 1) {
                const over = onSlide.some(
                    (other) => Math.abs(other.x - one.x) < 1e-6 && Math.abs(other.y - one.y) < 1e-6
                );
                if (!over) break;
                one = deck.copyOf(one, one.id);
            }
            return one;
        });
        edits.placeBoxes(doc, slide.id, placed);
        setChosen(placed[placed.length - 1]?.id ?? "");
        setEditing("");
    };

    // Listened for on the document, so the keys work from the moment the deck
    // opens rather than once something in it was clicked - but only for a
    // press or a paste on the page itself or inside the editor. Never one in a
    // dialog over it: the shortcut settings are exactly where somebody presses
    // Delete on purpose.
    const live = useRef({ onKeyDown, onCopy, onPaste });
    live.current = { onKeyDown, onCopy, onPaste };
    useEffect(() => {
        const ours = (target: EventTarget | null): boolean =>
            target === document.body ||
            target === document.documentElement ||
            (target instanceof Node && root.current?.contains(target) === true);
        const key = (event: KeyboardEvent): void => {
            if (!event.defaultPrevented && ours(event.target)) live.current.onKeyDown(event);
        };
        const copy = (event: ClipboardEvent): void => {
            if (ours(event.target)) live.current.onCopy(event, false);
        };
        const cut = (event: ClipboardEvent): void => {
            if (ours(event.target)) live.current.onCopy(event, true);
        };
        const paste = (event: ClipboardEvent): void => {
            if (ours(event.target)) live.current.onPaste(event);
        };
        document.addEventListener("keydown", key);
        document.addEventListener("copy", copy);
        document.addEventListener("cut", cut);
        document.addEventListener("paste", paste);
        return () => {
            document.removeEventListener("keydown", key);
            document.removeEventListener("copy", copy);
            document.removeEventListener("cut", cut);
            document.removeEventListener("paste", paste);
        };
    }, []);

    if (deckSlides.length === 0) {
        return (
            <div className="flex min-h-0 flex-1 items-center justify-center p-8">
                <div className="flex flex-col items-center gap-3 text-center">
                    <p className="text-[13px] font-medium">{t("slides.noSlidesYet")}</p>
                    <p className="max-w-sm text-[13px] text-muted-foreground">
                        {t("slides.everythingOnASlideIs")}
                    </p>
                    {editable ? (
                        <Button onClick={addSlide}>
                            <Plus className="size-4 shrink-0" aria-hidden />
                            {t("slides.addTheFirstSlide")}
                        </Button>
                    ) : null}
                </div>
            </div>
        );
    }

    return (
        <>
            <div ref={root} className="flex min-h-0 flex-1">
                {/* The slides. A column of them rather than a strip: a deck is read
                top to bottom in every tool that makes one. */}
                <aside className="hidden w-44 shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain border-r border-border p-2 sm:flex">
                    {deckSlides.map((one, index) => (
                        <button
                            key={one.id}
                            type="button"
                            onClick={() => goTo(index)}
                            aria-current={index === at ? "true" : undefined}
                            className={cn(
                                "relative aspect-video w-full shrink-0 overflow-hidden rounded-md border bg-background text-left transition-colors",
                                index === at
                                    ? "border-primary ring-1 ring-primary"
                                    : "border-border hover:border-border-strong"
                            )}
                        >
                            <SlideDrawing boxes={bySlide.get(one.id) ?? []} />
                            <span className="absolute bottom-1 left-1 rounded bg-background/80 px-1 text-[10px] text-muted-foreground">
                                {index + 1}
                            </span>
                        </button>
                    ))}
                    {editable ? (
                        <Button
                            variant="secondary"
                            size="sm"
                            className="shrink-0"
                            onClick={addSlide}
                        >
                            <Plus className="size-4 shrink-0" aria-hidden />
                            {t("slides.slide")}
                        </Button>
                    ) : null}
                </aside>

                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
                        {editable ? (
                            <>
                                <ToolButton
                                    label={t("slides.undo")}
                                    disabled={!history.canUndo}
                                    onClick={history.undo}
                                >
                                    <Undo2 className="size-4 shrink-0" aria-hidden />
                                </ToolButton>
                                <ToolButton
                                    label={t("slides.redo")}
                                    disabled={!history.canRedo}
                                    onClick={history.redo}
                                >
                                    <Redo2 className="size-4 shrink-0" aria-hidden />
                                </ToolButton>
                                <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                                <Button variant="ghost" size="sm" onClick={() => addBox("text")}>
                                    <Type className="size-4 shrink-0" aria-hidden />
                                    {t("slides.text")}
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => addBox("shape")}>
                                    <Square className="size-4 shrink-0" aria-hidden />
                                    {t("slides.shape")}
                                </Button>
                                <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                                <ToolButton
                                    label={t("slides.duplicateBox")}
                                    disabled={!chosenBox}
                                    onClick={duplicateChosen}
                                >
                                    <CopyPlus className="size-4 shrink-0" aria-hidden />
                                </ToolButton>
                                <ToolButton
                                    label={t("slides.deleteBox")}
                                    disabled={!chosenBox}
                                    onClick={removeChosen}
                                >
                                    <Trash2 className="size-4 shrink-0" aria-hidden />
                                </ToolButton>
                                <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                        if (!slide) return;
                                        edits.duplicateSlide(doc, slide.id, at);
                                        goTo(at + 1);
                                    }}
                                >
                                    <Copy className="size-4 shrink-0" aria-hidden />
                                    {t("slides.duplicateSlide")}
                                </Button>
                            </>
                        ) : null}
                        <div className="ml-auto flex items-center gap-1">
                            <ToolButton
                                label={t("slides.shortcuts")}
                                onClick={() => setHelpOpen(true)}
                            >
                                <Keyboard className="size-4 shrink-0" aria-hidden />
                            </ToolButton>
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => setPresenting(true)}
                            >
                                <Play className="size-4 shrink-0" aria-hidden />
                                {t("slides.present")}
                            </Button>
                        </div>
                    </div>

                    {/* The slide, as large as the room allows in both directions:
                    sized off this area's own width and height, so a short
                    window shows the whole slide rather than a scrolled part. */}
                    <div className="min-h-0 flex-1 bg-muted/30 p-4 [container-type:size]">
                        <div className="flex h-full w-full items-center justify-center">
                            <div
                                className="relative aspect-video overflow-hidden rounded-lg border border-border bg-background shadow-sm"
                                style={{ width: "min(100cqw, calc(100cqh * 16 / 9))" }}
                            >
                                {editable && slide ? (
                                    <SlideStage
                                        label={t("slides.canvas", { number: at + 1 })}
                                        boxes={onSlide}
                                        chosen={chosenBox?.id ?? ""}
                                        editing={editing}
                                        placeholder={t("slides.clickToAddText")}
                                        shapeLabel={t("slides.shape")}
                                        resizeLabel={t("slides.resize")}
                                        onChoose={setChosen}
                                        onEdit={setEditing}
                                        onFrame={(id, frame) =>
                                            edits.setFrame(doc, slide.id, id, frame)
                                        }
                                        onText={(id, text) =>
                                            edits.updateBox(doc, slide.id, id, { text })
                                        }
                                    />
                                ) : (
                                    <SlideDrawing boxes={onSlide} />
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            {presenting ? (
                <Present
                    slides={deckSlides}
                    bySlide={bySlide}
                    from={at}
                    onClose={() => setPresenting(false)}
                />
            ) : null}
            <ShortcutsDialog app="office" open={helpOpen} onOpenChange={setHelpOpen} />
        </>
    );
}

/** A toolbar action shown as its icon alone, named for screen readers and on
 *  hover. */
function ToolButton({
    label,
    disabled,
    onClick,
    children
}: {
    label: string;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
        >
            {children}
        </Button>
    );
}

/** The deck, full screen. Arrow keys and Escape, which is the whole interface
 *  anybody uses while presenting. */
function Present({
    slides,
    bySlide,
    from,
    onClose
}: {
    slides: readonly deck.Slide[];
    bySlide: ReadonlyMap<string, readonly deck.Box[]>;
    from: number;
    onClose: () => void;
}) {
    const t = useTranslations("office");
    const [at, setAt] = useState(from);
    const slide = slides[at];
    return (
        <div
            role="dialog"
            aria-label={t("slides.presenting")}
            tabIndex={-1}
            autoFocus
            onKeyDown={(event) => {
                // Its own keys, never the editor's underneath.
                event.stopPropagation();
                if (event.key === "Escape") onClose();
                if (shortcutPressed(event, "viewer.nextSlide")) {
                    setAt((one) => Math.min(slides.length - 1, one + 1));
                }
                if (shortcutPressed(event, "viewer.previousSlide"))
                    setAt((one) => Math.max(0, one - 1));
            }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black outline-none"
        >
            <Button
                variant="ghost"
                size="icon"
                aria-label={t("slides.stopPresenting")}
                title={t("slides.stopPresenting")}
                className="absolute right-3 top-3 text-white"
                onClick={onClose}
            >
                <X className="size-5 shrink-0" aria-hidden />
            </Button>
            <div className="relative aspect-video w-full max-w-[95vw] bg-background sm:max-h-[90vh]">
                {slide ? <SlideDrawing boxes={bySlide.get(slide.id) ?? []} /> : null}
            </div>
            <p className="mt-3 text-[12px] text-white/60">
                {t("slides.counter", { at: at + 1, total: slides.length })}
            </p>
        </div>
    );
}
