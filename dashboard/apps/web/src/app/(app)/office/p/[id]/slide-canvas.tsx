"use client";

/**
 * One slide, drawn - and the same slide, being worked on.
 *
 * `SlideDrawing` is the picture: the thumbnail, the full screen and the canvas
 * all draw it, which is the whole reason positions are fractions - three sizes,
 * one drawing, and no chance of the thumbnail disagreeing with the slide.
 *
 * `SlideStage` is that picture with hands on it: choose a box, drag it, pull one
 * of its eight grips, type into it in place. How it behaves is borrowed from the
 * editors people already know rather than invented: the grips and their
 * modifiers (Shift keeps the proportions, Alt grows from the middle) are
 * Excalidraw's and PowerPoint's, a second click on a chosen text box puts the
 * caret in it as in Google Slides. A drag is drawn locally and written once, on
 * release, so it is one step back and one change on the wire rather than sixty.
 */

import { cn } from "@polaris/ui";
import * as deck from "@/lib/office/deck";
import {
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type PointerEvent as ReactPointerEvent
} from "react";

/** How far a press may wander before it counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 3;

const HANDLE_CURSOR: Readonly<Record<deck.Handle, string>> = {
    nw: "nwse-resize",
    se: "nwse-resize",
    ne: "nesw-resize",
    sw: "nesw-resize",
    n: "ns-resize",
    s: "ns-resize",
    e: "ew-resize",
    w: "ew-resize"
};

const HANDLE_AT: Readonly<Record<deck.Handle, readonly [number, number]>> = {
    nw: [0, 0],
    n: [0.5, 0],
    ne: [1, 0],
    e: [1, 0.5],
    se: [1, 1],
    s: [0.5, 1],
    sw: [0, 1],
    w: [0, 0.5]
};

function frameStyle(frame: deck.BoxFrame): CSSProperties {
    return {
        left: `${frame.x * 100}%`,
        top: `${frame.y * 100}%`,
        width: `${frame.w * 100}%`,
        height: `${frame.h * 100}%`
    };
}

/** What the words in a text box look like, wherever it is drawn. */
function textStyle(box: deck.Box): CSSProperties {
    return {
        // A fraction of the slide's height, so words scale with it. `cqh`
        // measures the nearest size container, which is the slide's own layer.
        fontSize: `${box.size * 100}cqh`,
        lineHeight: 1.2,
        color: box.color || undefined,
        textAlign: box.align
    };
}

function BoxBody({ box }: { box: deck.Box }) {
    if (box.kind === "text") {
        return (
            <div className="h-full w-full whitespace-pre-wrap break-words" style={textStyle(box)}>
                {box.text}
            </div>
        );
    }
    if (box.kind === "image" && box.src) {
        return (
            <img src={box.src} alt="" draggable={false} className="h-full w-full object-contain" />
        );
    }
    return null;
}

/** Whether what is in a box is cut at its edge. Words are not: a line longer
 *  than its box runs on past it, as in PowerPoint and Google Slides, instead of
 *  vanishing - the slide's own edge is the only one that cuts them. */
function clipped(box: deck.Box): boolean {
    return box.kind !== "text";
}

/** Below this many pixels a box shows only its corner grips: the side ones would
 *  cover the box itself, and it could no longer be picked up (as in Excalidraw). */
const SIDE_GRIPS_FROM_PX = 56;

/** Below this many pixels the corner grips sit outside the box rather than
 *  across its corners, so a small box still has a middle to press on. */
const OUTSIDE_GRIPS_BELOW_PX = 40;

function boxStyle(box: deck.Box, frame: deck.BoxFrame): CSSProperties {
    return {
        ...frameStyle(frame),
        background: box.kind === "shape" ? box.fill || "#7c5cff" : undefined,
        borderRadius: box.kind === "shape" ? "0.5rem" : undefined
    };
}

/** A slide as a picture. Fills the box it is put in, which must be 16:9. */
export function SlideDrawing({ boxes }: { boxes: readonly deck.Box[] }) {
    return (
        <div
            className="pointer-events-none absolute inset-0 select-none [container-type:size]"
            aria-hidden
        >
            {boxes.map((box) => (
                <div
                    key={box.id}
                    className={cn("absolute", clipped(box) && "overflow-hidden")}
                    style={boxStyle(box, box)}
                >
                    <BoxBody box={box} />
                </div>
            ))}
        </div>
    );
}

type Gesture =
    | { kind: "move"; id: string; start: deck.BoxFrame; wasChosen: boolean }
    | { kind: "resize"; id: string; start: deck.BoxFrame; handle: deck.Handle };

export function SlideStage({
    label,
    boxes,
    chosen,
    editing,
    placeholder,
    shapeLabel,
    resizeLabel,
    onChoose,
    onEdit,
    onFrame,
    onText
}: {
    label: string;
    boxes: readonly deck.Box[];
    chosen: string;
    editing: string;
    /** What an empty text box says while it is being made, never when shown. */
    placeholder: string;
    shapeLabel: string;
    resizeLabel: string;
    onChoose: (id: string) => void;
    onEdit: (id: string) => void;
    onFrame: (id: string, frame: deck.BoxFrame) => void;
    onText: (id: string, text: string) => void;
}) {
    const layer = useRef<HTMLDivElement | null>(null);
    const [draft, setDraft] = useState<{ id: string; frame: deck.BoxFrame } | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const one = layer.current;
        if (!one) return;
        const watch = new ResizeObserver(([entry]) => {
            if (entry)
                setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
        });
        watch.observe(one);
        return () => watch.disconnect();
    }, []);
    const gestureEnd = useRef<(() => void) | null>(null);

    // A gesture still running when the slide goes away is dropped, never left
    // listening on the window.
    useEffect(() => () => gestureEnd.current?.(), []);

    const begin = (event: ReactPointerEvent, gesture: Gesture): void => {
        if (event.button !== 0 || !layer.current) return;
        const bounds = layer.current.getBoundingClientRect();
        const fromX = event.clientX;
        const fromY = event.clientY;
        let moved = false;
        let last: deck.BoxFrame = gesture.start;

        const frameAt = (at: {
            clientX: number;
            clientY: number;
            shiftKey: boolean;
            altKey: boolean;
        }) => {
            const dx = (at.clientX - fromX) / bounds.width;
            const dy = (at.clientY - fromY) / bounds.height;
            if (gesture.kind === "move") {
                return deck.clampFrame({
                    ...gesture.start,
                    x: gesture.start.x + dx,
                    y: gesture.start.y + dy
                });
            }
            return deck.resizeFrame(gesture.start, gesture.handle, dx, dy, {
                keepRatio: at.shiftKey,
                fromCenter: at.altKey
            });
        };
        const move = (at: PointerEvent): void => {
            if (!moved && Math.hypot(at.clientX - fromX, at.clientY - fromY) < DRAG_THRESHOLD_PX)
                return;
            moved = true;
            last = frameAt(at);
            setDraft({ id: gesture.id, frame: last });
        };
        const finish = (commit: boolean): void => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", cancel);
            window.removeEventListener("keydown", escape, true);
            gestureEnd.current = null;
            setDraft(null);
            if (!commit) return;
            if (moved) onFrame(gesture.id, last);
            // A click on a text box that was already chosen puts the caret in it.
            else if (gesture.kind === "move" && gesture.wasChosen) onEdit(gesture.id);
        };
        const up = (): void => finish(true);
        const cancel = (): void => finish(false);
        // Escape mid-drag puts the box back where it was, as in every editor.
        const escape = (press: KeyboardEvent): void => {
            if (press.key !== "Escape") return;
            press.preventDefault();
            press.stopPropagation();
            finish(false);
        };
        gestureEnd.current = () => finish(false);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("keydown", escape, true);
    };

    const chosenBox = boxes.find((box) => box.id === chosen);
    const chosenFrame = chosenBox ? (draft?.id === chosenBox.id ? draft.frame : chosenBox) : null;

    return (
        <div
            ref={layer}
            role="group"
            aria-label={label}
            tabIndex={-1}
            className="absolute inset-0 touch-none select-none outline-none [container-type:size]"
            onPointerDown={(event) => {
                // A press on the slide itself, between boxes, lets go of the box.
                if (event.target !== event.currentTarget) return;
                onEdit("");
                onChoose("");
                event.currentTarget.focus();
            }}
        >
            {boxes.map((box) => {
                const frame = draft?.id === box.id ? draft.frame : box;
                const typing = editing === box.id && box.kind === "text";
                return (
                    <div
                        key={box.id}
                        data-box={box.id}
                        role="button"
                        tabIndex={0}
                        aria-pressed={chosen === box.id}
                        aria-label={
                            box.kind === "text" ? box.text.trim() || placeholder : shapeLabel
                        }
                        onFocus={() => {
                            if (chosen !== box.id) onChoose(box.id);
                        }}
                        onPointerDown={(event) => {
                            if (typing) return;
                            const wasChosen = chosen === box.id;
                            if (!wasChosen) onEdit("");
                            onChoose(box.id);
                            begin(event, { kind: "move", id: box.id, start: box, wasChosen });
                        }}
                        onDoubleClick={() => {
                            if (box.kind === "text") onEdit(box.id);
                        }}
                        className={cn(
                            "absolute outline-none",
                            clipped(box) && "overflow-hidden",
                            !typing && "cursor-move"
                        )}
                        style={boxStyle(box, frame)}
                    >
                        {typing ? (
                            <TextEditor
                                box={box}
                                onDone={(text) => {
                                    onText(box.id, text);
                                    onEdit("");
                                }}
                            />
                        ) : box.kind === "text" && !box.text.trim() ? (
                            <div
                                className="h-full w-full text-muted-foreground"
                                style={{ ...textStyle(box), color: undefined }}
                            >
                                {placeholder}
                            </div>
                        ) : (
                            <BoxBody box={box} />
                        )}
                    </div>
                );
            })}

            {chosenBox && chosenFrame ? (
                <div
                    className="pointer-events-none absolute outline outline-2 outline-primary"
                    style={frameStyle(chosenFrame)}
                >
                    {editing === chosenBox.id
                        ? null
                        : deck.HANDLES.filter((handle) => {
                              if (handle.length === 2) return true;
                              const across = chosenFrame.w * size.width;
                              const down = chosenFrame.h * size.height;
                              return handle === "n" || handle === "s"
                                  ? across >= SIDE_GRIPS_FROM_PX
                                  : down >= SIDE_GRIPS_FROM_PX;
                          }).map((handle) => {
                              const [across, down] = HANDLE_AT[handle];
                              const shift = (at: number, room: number): string =>
                                  at === 0.5 || room >= OUTSIDE_GRIPS_BELOW_PX
                                      ? "-50%"
                                      : at === 0
                                        ? "-100%"
                                        : "0%";
                              const translate = `translate(${shift(across, chosenFrame.w * size.width)}, ${shift(down, chosenFrame.h * size.height)})`;
                              return (
                                  <span
                                      key={handle}
                                      role="presentation"
                                      title={resizeLabel}
                                      onPointerDown={(event) => {
                                          event.stopPropagation();
                                          begin(event, {
                                              kind: "resize",
                                              id: chosenBox.id,
                                              start: chosenBox,
                                              handle
                                          });
                                      }}
                                      className="pointer-events-auto absolute flex size-5 items-center justify-center"
                                      style={{
                                          left: `${across * 100}%`,
                                          top: `${down * 100}%`,
                                          transform: translate,
                                          cursor: HANDLE_CURSOR[handle]
                                      }}
                                  >
                                      <span className="size-2.5 rounded-sm border border-primary bg-background shadow-sm" />
                                  </span>
                              );
                          })}
                </div>
            ) : null}
        </div>
    );
}

/**
 * The words of one box, being typed.
 *
 * A plain text area laid exactly over the box, uncontrolled: what somebody else
 * changes meanwhile never moves this caret, and the words are written once, as
 * the editing ends - on leaving the box, or Escape.
 */
function TextEditor({ box, onDone }: { box: deck.Box; onDone: (text: string) => void }) {
    const field = useRef<HTMLTextAreaElement | null>(null);
    const done = useRef(onDone);
    done.current = onDone;
    const finished = useRef(false);
    const finish = (text: string): void => {
        if (finished.current) return;
        finished.current = true;
        done.current(text);
    };
    useEffect(() => {
        const one = field.current;
        if (!one) return;
        one.focus();
        one.setSelectionRange(one.value.length, one.value.length);
        // Taken away without losing focus first - a press on the slide around
        // it, another slide chosen - the words are still kept: a removed field
        // is not promised a blur.
        return () => {
            if (!finished.current) {
                finished.current = true;
                done.current(one.value);
            }
        };
    }, []);
    return (
        <textarea
            ref={field}
            defaultValue={box.text}
            spellCheck
            onBlur={(event) => finish(event.currentTarget.value)}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                const host = event.currentTarget.closest<HTMLElement>("[data-box]");
                event.currentTarget.blur();
                host?.focus();
            }}
            className="block h-full w-full resize-none overflow-hidden bg-transparent p-0 outline-none"
            style={textStyle(box)}
        />
    );
}
