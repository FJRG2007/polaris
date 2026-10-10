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
import { Present } from "./present";
import { FormatBar, patchFits, type BoxPatch, type PatchTarget } from "./format-bar";
import { DesignBar, LayoutItems } from "./design-bar";
import { SlideList } from "./slide-list";
import { NotesPanel } from "./notes-panel";
import { PresenterView } from "./presenter";
import { isPicture, readPicture, type PictureRefusal } from "./image-file";
import { ImageSourceProvider, SlideDrawing, SlideLookProvider, SlideStage } from "./slide-canvas";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useOfficeDocument } from "@/app/(app)/office/use-office-document";
import { ShortcutsDialog } from "@/components/shortcuts/shortcuts-dialog";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    matchShortcut,
    ScrollRow,
    ShortcutHint,
    useToast
} from "@polaris/ui";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ComponentType,
    type ReactNode
} from "react";
import {
    ArrowRight,
    ChevronDown,
    Circle,
    CopyPlus,
    Diamond,
    ImagePlus,
    Keyboard,
    Minus,
    MoveRight,
    Play,
    Plus,
    Presentation,
    Redo2,
    Shapes,
    SkipBack,
    Square,
    Squircle,
    Trash2,
    Triangle,
    Type,
    Undo2
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
    "office.slides.presentFromStart",
    "office.slides.newSlide",
    "office.slides.help",
    "office.slides.bold",
    "office.slides.italic",
    "office.slides.underline",
    "office.slides.align.left",
    "office.slides.align.center",
    "office.slides.align.right",
    "office.slides.bringForward",
    "office.slides.sendBackward",
    "office.slides.bringToFront",
    "office.slides.sendToBack",
    "office.slides.selectAll",
    "office.slides.group",
    "office.slides.ungroup"
] as const;

/** The keys that change how the chosen box's words look - the ones that also
 *  work while typing in it, since a box's words are formatted whole. */
const FORMAT_KEYS = new Set<string>([
    "office.slides.bold",
    "office.slides.italic",
    "office.slides.underline",
    "office.slides.align.left",
    "office.slides.align.center",
    "office.slides.align.right"
]);

const ARRANGE_KEYS: Readonly<Record<string, deck.Arrange>> = {
    "office.slides.bringForward": "forward",
    "office.slides.sendBackward": "backward",
    "office.slides.bringToFront": "front",
    "office.slides.sendToBack": "back"
};

/** The shapes the Shape menu offers, areas first and lines after. */
const SHAPE_ICON: Readonly<Record<deck.ShapeKind, ComponentType<{ className?: string }>>> = {
    rect: Square,
    rounded: Squircle,
    ellipse: Circle,
    triangle: Triangle,
    diamond: Diamond,
    arrowRight: ArrowRight,
    line: Minus,
    arrow: MoveRight
};

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
    editable,
    audienceWindow = false
}: {
    documentId: string;
    content: number[] | null;
    editable: boolean;
    /** Whether the presenter view may open the audience window, which needs the
     *  signed-in access a deck opened through a share link does not have. */
    audienceWindow?: boolean;
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
    const notes = useMemo(() => new Map(edits.notesOf(doc).entries()), [doc, version]);
    const notesFor = useCallback((one: deck.Slide) => deck.notesOf(one, notes), [notes]);
    // A new function whenever the document changes, so a picture that arrives
    // after its box redraws everything that shows it.
    const imageSource = useCallback((src: string) => edits.imageSource(doc, src), [doc, version]);
    const theme = useMemo(
        () => deck.readTheme(new Map(edits.themeOf(doc).entries())),
        [doc, version]
    );
    const backgrounds = useMemo(() => new Map(edits.backgroundsOf(doc).entries()), [doc, version]);
    const lookFor = useCallback(
        (slideId: string) => deck.lookOf(theme, backgrounds, slideId),
        [theme, backgrounds]
    );
    const toast = useToast();
    const picker = useRef<HTMLInputElement | null>(null);
    const [atIndex, setAtIndex] = useState(0);
    /** The boxes chosen, in the order they were. */
    const [chosen, setChosen] = useState<string[]>([]);
    const [editing, setEditing] = useState("");
    /** The slide the show started from, and how it is shown, while it runs. */
    const [presenting, setPresenting] = useState<{
        from: number;
        presenter: boolean;
    } | null>(null);
    const present = useCallback(
        (from: number, presenter = false) => setPresenting({ from, presenter }),
        []
    );
    const [helpOpen, setHelpOpen] = useState(false);
    const root = useRef<HTMLDivElement | null>(null);

    const at = Math.min(atIndex, deckSlides.length - 1);
    const slide = deckSlides[at] ?? null;
    const onSlide = useMemo(() => (slide ? (bySlide.get(slide.id) ?? []) : []), [bySlide, slide]);
    // What is chosen is read off the slide as it is now, so a box somebody else
    // just removed is not still offered to the toolbar.
    const chosenBoxes = useMemo(
        () => onSlide.filter((box) => chosen.includes(box.id)),
        [onSlide, chosen]
    );
    const chosenIds = chosenBoxes.map((box) => box.id);
    const single = chosenBoxes.length === 1 ? chosenBoxes[0]! : null;

    const goTo = useCallback((index: number) => {
        setAtIndex(index);
        setChosen([]);
        setEditing("");
    }, []);

    /** A new slide after this one - a title and a body, as Ctrl+M makes one in
     *  Google Slides, unless another layout was picked. */
    const addSlide = useCallback(
        (layout: deck.Layout = deck.NEXT_LAYOUT) => {
            // The first slide of a deck is its title slide.
            edits.addSlide(doc, at + 1, deckSlides.length === 0 ? "title" : layout);
            goTo(at + 1);
        },
        [at, doc, goTo, deckSlides.length]
    );

    const listActions = {
        onGo: goTo,
        onAdd: (after: number) => {
            edits.addSlide(doc, after + 1, deck.NEXT_LAYOUT);
            goTo(after + 1);
        },
        onDuplicate: (index: number) => {
            const one = deckSlides[index];
            if (!one) return;
            edits.duplicateSlide(doc, one.id, index);
            goTo(index + 1);
        },
        onDelete: (index: number) => {
            const one = deckSlides[index];
            if (!one) return;
            edits.removeSlide(doc, one.id);
            // The next slide takes its place; the last one's place is taken by
            // the one before it.
            if (index === at) goTo(Math.max(0, Math.min(index, deckSlides.length - 2)));
            else if (index < at) setAtIndex(at - 1);
        },
        onMove: (from: number, to: number) => {
            edits.moveSlide(doc, from, to);
            if (from === at) setAtIndex(to);
            else if (from < at && to >= at) setAtIndex(at - 1);
            else if (from > at && to <= at) setAtIndex(at + 1);
        }
    };

    /** The keyboard on a box, once it is drawn - so the keys that act on the
     *  chosen box (Delete, the arrows, Ctrl+B) work on one just inserted, rather
     *  than on the toolbar button or menu that inserted it. */
    const focusBox = (id: string): void => {
        requestAnimationFrame(() =>
            requestAnimationFrame(() =>
                root.current?.querySelector<HTMLElement>(`[data-box="${CSS.escape(id)}"]`)?.focus()
            )
        );
    };

    const addBox = (kind: deck.BoxKind, shape?: deck.ShapeKind): void => {
        if (!slide) return;
        const id = edits.addBox(doc, slide.id, kind, shape);
        setChosen([id]);
        // A new text box is for typing into, straight away.
        setEditing(kind === "text" ? id : "");
        if (kind !== "text") focusBox(id);
    };

    const refusal = (reason: PictureRefusal): string =>
        reason === "notAPicture"
            ? t("slides.image.notAPicture")
            : reason === "tooLarge"
              ? t("slides.image.tooLarge")
              : t("slides.image.unreadable");

    const slideRef = useRef("");
    slideRef.current = slide?.id ?? "";

    /** Pictures put on the slide - chosen, dropped or pasted - each its own box,
     *  in its own proportions. */
    const addPictures = async (files: readonly File[]): Promise<void> => {
        if (!slide || !editable) return;
        const target = slide.id;
        let last = "";
        for (const file of files) {
            const read = await readPicture(file);
            if (!read.ok) {
                toast.show({ title: refusal(read.reason) });
                continue;
            }
            last = edits.addImage(doc, target, read.data, deck.imageFrame(read.width, read.height));
        }
        if (last && slideRef.current === target) {
            setChosen([last]);
            setEditing("");
            focusBox(last);
        }
    };

    /** A change to every chosen box it means something on. */
    const patchChosen = (patch: BoxPatch, to: PatchTarget): void => {
        if (!slide || chosenIds.length === 0) return;
        edits.updateBoxes(doc, slide.id, chosenIds, patch, (box) => patchFits(box, to));
    };

    const placeholderOf = (box: deck.Box): string =>
        box.role === "title"
            ? t("slides.clickToAddTitle")
            : box.role === "subtitle"
              ? t("slides.clickToAddSubtitle")
              : t("slides.clickToAddText");

    const nameOf = (box: deck.Box): string => {
        if (box.kind === "image") return t("slides.image.name");
        const words = box.text.trim();
        if (box.kind === "text") return words || placeholderOf(box);
        const shape = t(`slides.shapes.${box.shape}`);
        return words ? `${shape}: ${words}` : shape;
    };

    /** Copies of the chosen boxes, a step down and right, chosen instead - a
     *  copied group a group of its own. */
    const duplicateChosen = (): void => {
        if (!slide || chosenBoxes.length === 0) return;
        const groups = new Map<string, string>();
        const copies = deck.stackOrder(chosenBoxes).map((box) => {
            const copy = deck.copyOf(box, crypto.randomUUID());
            if (!box.group) return copy;
            if (!groups.has(box.group)) groups.set(box.group, crypto.randomUUID());
            return { ...copy, group: groups.get(box.group)! };
        });
        edits.placeBoxes(doc, slide.id, copies);
        setChosen(copies.map((box) => box.id));
    };

    const removeChosen = (): void => {
        if (!slide || chosenIds.length === 0) return;
        edits.removeBoxes(doc, slide.id, chosenIds);
        setChosen([]);
        setEditing("");
    };

    const groupChosen = (): boolean => {
        if (!slide || !deck.canGroup(chosenBoxes)) return false;
        edits.groupBoxes(doc, slide.id, chosenIds);
        return true;
    };

    const ungroupChosen = (): boolean => {
        if (!slide || !deck.canUngroup(chosenBoxes)) return false;
        edits.ungroupBoxes(doc, slide.id, chosenIds);
        return true;
    };

    const alignChosen = (how: deck.AlignBoxes): void => {
        if (!slide) return;
        edits.setFrames(doc, slide.id, deck.alignBoxes(chosenBoxes, how));
    };

    const distributeChosen = (axis: "x" | "y"): void => {
        if (!slide) return;
        edits.setFrames(doc, slide.id, deck.distributeBoxes(chosenBoxes, axis));
    };

    /** The chosen boxes moved by the arrow keys, together: the frame round
     *  them stops at the slide's edge, so they keep their places among
     *  themselves. */
    const nudgeChosen = (right: number, down: number, far: boolean): void => {
        if (!slide || chosenBoxes.length === 0) return;
        const around = deck.boundsOf(chosenBoxes);
        const moved = deck.nudgeFrame(around, right, down, far, 0);
        const dx = moved.x - around.x;
        const dy = moved.y - around.y;
        edits.setFrames(
            doc,
            slide.id,
            new Map(
                chosenBoxes.map((box) => [
                    box.id,
                    { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }
                ])
            )
        );
    };

    const formatKey = (action: string): boolean => {
        // Shown, and toggled, as the first chosen box with words has it.
        const first = chosenBoxes.find((box) => deck.holdsText(box));
        if (!first) return false;
        const words = (patch: BoxPatch): true => {
            patchChosen(patch, "words");
            return true;
        };
        switch (action) {
            case "office.slides.bold":
                return words({ bold: !first.bold });
            case "office.slides.italic":
                return words({ italic: !first.italic });
            case "office.slides.underline":
                return words({ underline: !first.underline });
            case "office.slides.align.left":
                return words({ align: "left" });
            case "office.slides.align.center":
                return words({ align: "center" });
            case "office.slides.align.right":
                return words({ align: "right" });
        }
        return false;
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        if (typingIn(event.target)) {
            // Typing in a box: its words are formatted whole, so Ctrl+B there
            // is the box's bold, exactly as with the box chosen.
            if (!editable || !(event.target as Element).closest("[data-box]")) return;
            const action = matchShortcut(event, KEYS);
            if (action && FORMAT_KEYS.has(action) && formatKey(action)) event.preventDefault();
            return;
        }
        const action = matchShortcut(event, KEYS);
        if (!action) return;
        const handled = ((): boolean => {
            if (editable) {
                switch (action) {
                    case "office.slides.undo":
                        history.undo();
                        return true;
                    case "office.slides.redo":
                        history.redo();
                        return true;
                }
            }
            if (deckSlides.length === 0) return false;
            switch (action) {
                case "office.slides.present":
                    present(at);
                    return true;
                case "office.slides.presentFromStart":
                    present(0);
                    return true;
                case "office.slides.help":
                    setHelpOpen(true);
                    return true;
                case "office.slides.deselect":
                    if (chosen.length === 0) return false;
                    setChosen([]);
                    return true;
            }
            if (!editable || !slide) return false;
            switch (action) {
                case "office.slides.newSlide":
                    addSlide();
                    return true;
                case "office.slides.selectAll":
                    if (onSlide.length === 0) return false;
                    setEditing("");
                    setChosen(onSlide.map((box) => box.id));
                    return true;
            }
            // A plain key on a toolbar button is the button's own - Enter
            // presses it, an arrow moves along the row; one with Ctrl held is
            // the editor's, as after picking from a menu in Google Slides.
            const held = event.ctrlKey || event.metaKey;
            if (chosenBoxes.length === 0 || (!held && onControl(event.target))) return false;
            if (FORMAT_KEYS.has(action)) return formatKey(action);
            const how = ARRANGE_KEYS[action];
            if (how) {
                edits.arrangeBox(doc, slide.id, chosenIds, how);
                return true;
            }
            switch (action) {
                case "office.slides.duplicate":
                    duplicateChosen();
                    return true;
                case "office.slides.delete":
                    removeChosen();
                    return true;
                case "office.slides.edit":
                    if (!single || !deck.holdsText(single)) return false;
                    setEditing(single.id);
                    return true;
                case "office.slides.group":
                    return groupChosen();
                case "office.slides.ungroup":
                    return ungroupChosen();
                case "office.slides.nudge":
                case "office.slides.nudgeFar": {
                    const [right, down] = ARROWS[event.key] ?? [0, 0];
                    nudgeChosen(right, down, action === "office.slides.nudgeFar");
                    return true;
                }
            }
            return false;
        })();
        if (handled) event.preventDefault();
    };

    const onCopy = (event: ClipboardEvent, cut: boolean): void => {
        if (typingIn(event.target) || chosenBoxes.length === 0 || !event.clipboardData) return;
        event.preventDefault();
        const copied = deck.stackOrder(chosenBoxes);
        event.clipboardData.setData(deck.CLIPBOARD_TYPE, deck.writeClipboard(copied, imageSource));
        // Words as words, for pasting into anything that is not a deck.
        const words = copied
            .map((box) => box.text.trim())
            .filter(Boolean)
            .join("\n");
        if (words) event.clipboardData.setData("text/plain", words);
        if (cut && editable) removeChosen();
    };

    const onPaste = (event: ClipboardEvent): void => {
        if (typingIn(event.target) || !editable || !slide || !event.clipboardData) return;
        // A picture copied from anywhere - a screenshot, an image from a page -
        // goes on the slide as a picture.
        const files = [...event.clipboardData.files].filter(isPicture);
        if (files.length > 0 && !event.clipboardData.getData(deck.CLIPBOARD_TYPE)) {
            event.preventDefault();
            void addPictures(files);
            return;
        }
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
        edits.pasteBoxes(doc, slide.id, placed);
        setChosen(placed.map((box) => box.id));
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
            <div ref={root} className="flex min-h-0 flex-1 items-center justify-center p-8">
                <div className="flex flex-col items-center gap-3 text-center">
                    <p className="text-[13px] font-medium">{t("slides.noSlidesYet")}</p>
                    <p className="max-w-sm text-[13px] text-muted-foreground">
                        {t("slides.everythingOnASlideIs")}
                    </p>
                    {editable ? (
                        <div className="flex flex-wrap items-center justify-center gap-2">
                            <Button onClick={() => addSlide()}>
                                <Plus className="size-4 shrink-0" aria-hidden />
                                {t("slides.addTheFirstSlide")}
                            </Button>
                            {history.canUndo ? (
                                <Button variant="secondary" onClick={history.undo}>
                                    <Undo2 className="size-4 shrink-0" aria-hidden />
                                    {t("slides.undo")}
                                </Button>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            </div>
        );
    }

    return (
        <ImageSourceProvider source={imageSource}>
            <SlideLookProvider lookOf={lookFor}>
                <div ref={root} className="flex min-h-0 flex-1 max-sm:flex-col">
                    {/* The slides. A column of them rather than a strip: a deck is
                    read top to bottom in every tool that makes one. */}
                    <SlideList
                        slides={deckSlides}
                        bySlide={bySlide}
                        at={at}
                        editable={editable}
                        actions={listActions}
                    />

                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
                            {/* Everything that edits, in one row that scrolls
                            sideways when the window is too narrow for it,
                            rather than wrapping into rows that push the slide
                            down. */}
                            <ScrollRow className="flex min-w-0 flex-1 items-center gap-1">
                                {editable ? (
                                    <>
                                        <div className="flex shrink-0 items-center">
                                            <ToolButton
                                                label={t("slides.newSlide")}
                                                onClick={() => addSlide()}
                                            >
                                                <Plus className="size-4 shrink-0" aria-hidden />
                                            </ToolButton>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="shrink-0 px-1"
                                                        aria-label={t(
                                                            "slides.design.newSlideLayout"
                                                        )}
                                                        title={t("slides.design.newSlideLayout")}
                                                    >
                                                        <ChevronDown
                                                            className="size-3 shrink-0"
                                                            aria-hidden
                                                        />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="start">
                                                    <LayoutItems
                                                        onPick={(layout) => addSlide(layout)}
                                                    />
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </div>
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
                                        <span
                                            className="mx-1 h-5 w-px shrink-0 bg-border"
                                            aria-hidden
                                        />
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="shrink-0"
                                            title={t("slides.text")}
                                            onClick={() => addBox("text")}
                                        >
                                            <Type className="size-4 shrink-0" aria-hidden />
                                            {/* Named on the widest screens only: with a
                                            box chosen its formatting needs the row. */}
                                            <span className="max-2xl:sr-only">
                                                {t("slides.text")}
                                            </span>
                                        </Button>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="shrink-0"
                                                    title={t("slides.shape")}
                                                >
                                                    <Shapes
                                                        className="size-4 shrink-0"
                                                        aria-hidden
                                                    />
                                                    <span className="max-2xl:sr-only">
                                                        {t("slides.shape")}
                                                    </span>
                                                    <ChevronDown
                                                        className="size-3 shrink-0"
                                                        aria-hidden
                                                    />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent
                                                align="start"
                                                // The new shape takes the focus, not
                                                // the button that made it.
                                                onCloseAutoFocus={(event) => event.preventDefault()}
                                            >
                                                {deck.SHAPES.map((shape) => {
                                                    const Icon = SHAPE_ICON[shape];
                                                    return (
                                                        <div key={shape}>
                                                            {shape === deck.LINE_SHAPES[0] ? (
                                                                <DropdownMenuSeparator />
                                                            ) : null}
                                                            <DropdownMenuItem
                                                                onSelect={() =>
                                                                    addBox("shape", shape)
                                                                }
                                                            >
                                                                <Icon className="size-4" />
                                                                {t(`slides.shapes.${shape}`)}
                                                            </DropdownMenuItem>
                                                        </div>
                                                    );
                                                })}
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="shrink-0"
                                            title={t("slides.image.insert")}
                                            onClick={() => picker.current?.click()}
                                        >
                                            <ImagePlus className="size-4 shrink-0" aria-hidden />
                                            <span className="max-2xl:sr-only">
                                                {t("slides.image.insert")}
                                            </span>
                                        </Button>
                                        <input
                                            ref={picker}
                                            type="file"
                                            accept="image/*"
                                            multiple
                                            hidden
                                            onChange={(event) => {
                                                const files = [
                                                    ...(event.currentTarget.files ?? [])
                                                ];
                                                event.currentTarget.value = "";
                                                void addPictures(files);
                                            }}
                                        />
                                        <span
                                            className="mx-1 h-5 w-px shrink-0 bg-border"
                                            aria-hidden
                                        />
                                        <ToolButton
                                            label={t("slides.duplicateBox")}
                                            disabled={chosenBoxes.length === 0}
                                            onClick={duplicateChosen}
                                        >
                                            <CopyPlus className="size-4 shrink-0" aria-hidden />
                                        </ToolButton>
                                        <ToolButton
                                            label={t("slides.deleteBox")}
                                            disabled={chosenBoxes.length === 0}
                                            onClick={removeChosen}
                                        >
                                            <Trash2 className="size-4 shrink-0" aria-hidden />
                                        </ToolButton>
                                        {chosenBoxes.length > 0 && slide ? (
                                            <FormatBar
                                                boxes={chosenBoxes}
                                                onPatch={patchChosen}
                                                onArrange={(how) =>
                                                    edits.arrangeBox(doc, slide.id, chosenIds, how)
                                                }
                                                onAlign={alignChosen}
                                                onDistribute={distributeChosen}
                                                onGroup={groupChosen}
                                                onUngroup={ungroupChosen}
                                            />
                                        ) : slide ? (
                                            <DesignBar
                                                theme={theme}
                                                background={lookFor(slide.id).background}
                                                ownBackground={deck.hasOwnBackground(
                                                    backgrounds,
                                                    slide.id
                                                )}
                                                onBackground={(color) =>
                                                    edits.setBackground(doc, [slide.id], color)
                                                }
                                                onBackgroundEverywhere={() =>
                                                    edits.backgroundEverywhere(
                                                        doc,
                                                        lookFor(slide.id).background
                                                    )
                                                }
                                                onLayout={(layout) =>
                                                    edits.applyLayout(doc, slide.id, layout)
                                                }
                                                onTheme={(next) => edits.setTheme(doc, next)}
                                            />
                                        ) : null}
                                    </>
                                ) : null}
                            </ScrollRow>
                            <div className="flex shrink-0 items-center gap-1">
                                <ToolButton
                                    label={t("slides.shortcuts")}
                                    onClick={() => setHelpOpen(true)}
                                >
                                    <Keyboard className="size-4 shrink-0" aria-hidden />
                                </ToolButton>
                                <div className="flex items-center">
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        className="rounded-r-none"
                                        onClick={() => present(at)}
                                    >
                                        <Play className="size-4 shrink-0" aria-hidden />
                                        <span className="max-sm:sr-only">
                                            {t("slides.present")}
                                        </span>
                                    </Button>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                className="rounded-l-none border-l border-border px-1.5"
                                                aria-label={t("slides.presentOptions")}
                                                title={t("slides.presentOptions")}
                                            >
                                                <ChevronDown
                                                    className="size-4 shrink-0"
                                                    aria-hidden
                                                />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem onSelect={() => present(at)}>
                                                <Play aria-hidden />
                                                {t("slides.fromHere")}
                                                <ShortcutHint id="office.slides.present" />
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onSelect={() => present(0)}>
                                                <SkipBack aria-hidden />
                                                {t("slides.fromStart")}
                                                <ShortcutHint id="office.slides.presentFromStart" />
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem onSelect={() => present(at, true)}>
                                                <Presentation aria-hidden />
                                                {t("slides.presenter.title")}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>
                            </div>
                        </div>

                        {/* The slide, as large as the room allows in both directions:
                    sized off this area's own width and height, so a short
                    window shows the whole slide rather than a scrolled part. */}
                        <div
                            className="min-h-0 flex-1 bg-muted/30 p-4 [container-type:size]"
                            onDragOver={(event) => {
                                if (!editable || !event.dataTransfer.types.includes("Files"))
                                    return;
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "copy";
                            }}
                            onDrop={(event) => {
                                if (!editable) return;
                                const files = [...event.dataTransfer.files].filter(isPicture);
                                if (files.length === 0) return;
                                event.preventDefault();
                                void addPictures(files);
                            }}
                        >
                            <div className="flex h-full w-full items-center justify-center">
                                <div
                                    className="relative aspect-video overflow-hidden rounded-lg border border-border bg-white shadow-sm"
                                    style={{ width: "min(100cqw, calc(100cqh * 16 / 9))" }}
                                >
                                    {editable && slide ? (
                                        <SlideStage
                                            label={t("slides.canvas", { number: at + 1 })}
                                            slideId={slide.id}
                                            boxes={onSlide}
                                            chosen={chosenIds}
                                            editing={editing}
                                            placeholderOf={placeholderOf}
                                            nameOf={nameOf}
                                            resizeLabel={t("slides.resize")}
                                            lineEndLabel={t("slides.lineEnd")}
                                            onChoose={setChosen}
                                            onEdit={setEditing}
                                            onFrames={(frames) =>
                                                edits.setFrames(doc, slide.id, frames)
                                            }
                                            onText={(id, text) =>
                                                edits.updateBox(doc, slide.id, id, { text })
                                            }
                                        />
                                    ) : (
                                        <SlideDrawing boxes={onSlide} slideId={slide?.id ?? ""} />
                                    )}
                                </div>
                            </div>
                        </div>
                        {slide ? (
                            <NotesPanel
                                slideId={slide.id}
                                notes={notesFor(slide)}
                                editable={editable}
                                onWrite={(slideId, text) => {
                                    const one = edits
                                        .slidesOf(doc)
                                        .toArray()
                                        .find((s) => s.id === slideId);
                                    if (one) edits.setNotes(doc, one, text);
                                }}
                            />
                        ) : null}
                    </div>
                </div>
                {presenting?.presenter ? (
                    <PresenterView
                        documentId={documentId}
                        audienceWindow={audienceWindow}
                        slides={deckSlides}
                        bySlide={bySlide}
                        notesOf={notesFor}
                        from={presenting.from}
                        onClose={() => setPresenting(null)}
                    />
                ) : presenting ? (
                    <Present
                        slides={deckSlides}
                        bySlide={bySlide}
                        from={presenting.from}
                        onClose={() => setPresenting(null)}
                    />
                ) : null}
                <ShortcutsDialog app="office" open={helpOpen} onOpenChange={setHelpOpen} />
            </SlideLookProvider>
        </ImageSourceProvider>
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
