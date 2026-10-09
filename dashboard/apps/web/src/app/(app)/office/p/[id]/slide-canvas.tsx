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
 * Excalidraw's and PowerPoint's, a picture's corners keep its proportions unless
 * Shift is held (PowerPoint's locked aspect ratio), a line has a grip on each
 * end rather than a box round it, and a second click on a chosen box that holds
 * words puts the caret in it as in Google Slides. A drag is drawn locally and
 * written once, on release, so it is one step back and one change on the wire
 * rather than sixty.
 *
 * Shapes and lines are drawn in slide units - a slide 1600 wide and 900 high -
 * so an outline is the same share of the slide in a thumbnail as on a
 * projector, exactly as the words are.
 */

import { cn } from "@polaris/ui";
import * as deck from "@/lib/office/deck";
import {
    createContext,
    Fragment,
    useContext,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
    type ReactNode
} from "react";

/** How far a press may wander before it counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 3;

/** The slide, in the units shapes and lines are drawn in. */
const UNITS_W = 1600;
const UNITS_H = 900;

/** How wide, in pixels, the band round a line is that picks it up. */
const LINE_HIT_PX = 14;

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

/** What an image box's source turns into a picture with: the deck's own store,
 *  provided by the editor; a drawing outside it shows sources as they are. */
const ImageSource = createContext<(src: string) => string>((src) => src);

export function ImageSourceProvider({
    source,
    children
}: {
    source: (src: string) => string;
    children: ReactNode;
}) {
    return <ImageSource.Provider value={source}>{children}</ImageSource.Provider>;
}

function frameStyle(frame: deck.BoxFrame): CSSProperties {
    return {
        left: `${frame.x * 100}%`,
        top: `${frame.y * 100}%`,
        width: `${frame.w * 100}%`,
        height: `${frame.h * 100}%`
    };
}

/** How far a list's lines are indented, past their bullets or numbers. */
const LIST_INDENT = "1.3em";

/** What the words in a box look like, wherever it is drawn. */
function textStyle(box: deck.Box): CSSProperties {
    return {
        // A fraction of the slide's height, so words scale with it. `cqh`
        // measures the nearest size container, which is the slide's own layer.
        fontSize: `${box.size * 100}cqh`,
        lineHeight: 1.2,
        color: box.color || undefined,
        textAlign: box.align,
        fontWeight: box.bold ? 700 : undefined,
        fontStyle: box.italic ? "italic" : undefined,
        textDecorationLine: box.underline ? "underline" : undefined
    };
}

const JUSTIFY: Readonly<Record<deck.Box["valign"], CSSProperties["justifyContent"]>> = {
    top: "flex-start",
    middle: "center",
    bottom: "flex-end"
};

/** Where a box's words sit in it: up or down by its anchor, and, in a shape,
 *  kept off the outline. */
function TextLayer({ box, children }: { box: deck.Box; children: ReactNode }) {
    return (
        <div
            className="absolute inset-0 flex flex-col"
            style={{
                justifyContent: JUSTIFY[box.valign],
                padding: box.kind === "shape" ? "1.5cqh" : undefined
            }}
        >
            {children}
        </div>
    );
}

/** A box's words: as written, or one bullet or number per line. */
function Words({ box }: { box: deck.Box }) {
    const style = textStyle(box);
    if (box.list === "none") {
        return (
            <div className="shrink-0 whitespace-pre-wrap break-words" style={style}>
                {box.text}
            </div>
        );
    }
    const List = box.list === "number" ? "ol" : "ul";
    return (
        <List
            className="m-0 shrink-0 break-words"
            style={{
                ...style,
                listStyleType: box.list === "number" ? "decimal" : "disc",
                paddingLeft: LIST_INDENT
            }}
        >
            {box.text.split("\n").map((line, at) => (
                // An empty line still has its bullet, as in every deck editor.
                <li key={at} className="whitespace-pre-wrap">
                    {line || "​"}
                </li>
            ))}
        </List>
    );
}

function paint(color: string): string {
    return color && color !== "transparent" ? color : "none";
}

/** A box's outline and fill, drawn to its frame. A text box draws one only
 *  when it was given a fill or an outline. */
function ShapeArt({ box }: { box: deck.Box }) {
    const width = Math.max(1, box.w * UNITS_W);
    const height = Math.max(1, box.h * UNITS_H);
    const fill = paint(box.fill);
    const stroke = paint(box.stroke);
    if (box.kind === "text" && fill === "none" && stroke === "none") return null;
    const look = {
        fill,
        stroke,
        strokeWidth: stroke === "none" ? 0 : box.strokeWidth * UNITS_H,
        strokeLinejoin: "round" as const
    };
    const shape = box.kind === "text" ? "rect" : box.shape;
    const art = ((): ReactNode => {
        switch (shape) {
            case "rounded": {
                const radius = 0.16 * Math.min(width, height);
                return <rect width={width} height={height} rx={radius} ry={radius} {...look} />;
            }
            case "ellipse":
                return (
                    <ellipse
                        cx={width / 2}
                        cy={height / 2}
                        rx={width / 2}
                        ry={height / 2}
                        {...look}
                    />
                );
            case "triangle":
                return (
                    <polygon
                        points={`${width / 2},0 ${width},${height} 0,${height}`}
                        {...look}
                    />
                );
            case "diamond":
                return (
                    <polygon
                        points={`${width / 2},0 ${width},${height / 2} ${width / 2},${height} 0,${height / 2}`}
                        {...look}
                    />
                );
            case "arrowRight": {
                const head = Math.min(width * 0.6, height * 0.6);
                const shaftTop = height * 0.25;
                const shaftBottom = height * 0.75;
                return (
                    <polygon
                        points={[
                            `0,${shaftTop}`,
                            `${width - head},${shaftTop}`,
                            `${width - head},0`,
                            `${width},${height / 2}`,
                            `${width - head},${height}`,
                            `${width - head},${shaftBottom}`,
                            `0,${shaftBottom}`
                        ].join(" ")}
                        {...look}
                    />
                );
            }
            default:
                return <rect width={width} height={height} {...look} />;
        }
    })();
    return (
        <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
        >
            {art}
        </svg>
    );
}

/**
 * A line, drawn across the whole slide rather than inside its frame: a level
 * line's frame is no height at all, and an SVG with no height draws nothing.
 * `onPress`, on the editing canvas, makes a band round the stroke - not its
 * whole frame - the thing that picks it up, as in Google Slides.
 */
function LineArt({
    box,
    hitWidth,
    onPress
}: {
    box: deck.Box;
    hitWidth?: number;
    onPress?: (event: ReactPointerEvent) => void;
}) {
    const [start, end] = deck.lineEnds(box);
    const x1 = start.x * UNITS_W;
    const y1 = start.y * UNITS_H;
    let x2 = end.x * UNITS_W;
    let y2 = end.y * UNITS_H;
    const stroke = paint(box.stroke);
    const width = Math.max(0.5, box.strokeWidth * UNITS_H);
    const length = Math.hypot(x2 - x1, y2 - y1);
    let head: ReactNode = null;
    if (box.shape === "arrow" && length > 0) {
        const ux = (x2 - x1) / length;
        const uy = (y2 - y1) / length;
        const long = Math.min(length, Math.max(width * 4, 14));
        const half = long * 0.5;
        const baseX = x2 - ux * long;
        const baseY = y2 - uy * long;
        head = (
            <polygon
                points={`${x2},${y2} ${baseX - uy * half},${baseY + ux * half} ${baseX + uy * half},${baseY - ux * half}`}
                fill={stroke}
            />
        );
        // The stroke stops inside the head, so its round end never shows
        // past the point.
        x2 = baseX + ux * long * 0.2;
        y2 = baseY + uy * long * 0.2;
    }
    return (
        <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            viewBox={`0 0 ${UNITS_W} ${UNITS_H}`}
            preserveAspectRatio="none"
        >
            <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={stroke}
                strokeWidth={width}
                strokeLinecap="round"
            />
            {head}
            {onPress ? (
                <line
                    x1={x1}
                    y1={y1}
                    x2={end.x * UNITS_W}
                    y2={end.y * UNITS_H}
                    stroke="transparent"
                    strokeWidth={Math.max(width, hitWidth ?? 0)}
                    strokeLinecap="round"
                    pointerEvents="stroke"
                    className="cursor-move"
                    onPointerDown={onPress}
                />
            ) : null}
        </svg>
    );
}

function Picture({ box }: { box: deck.Box }) {
    const source = useContext(ImageSource);
    const src = box.src ? source(box.src) : "";
    // A picture somebody else just added can arrive a moment after its box.
    if (!src) return <div className="absolute inset-0 bg-muted" />;
    return (
        <img
            src={src}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-fill"
        />
    );
}

/** What is inside a box that is not a line, wherever it is drawn. */
function BoxBody({ box }: { box: deck.Box }) {
    return (
        <>
            {box.kind === "image" ? <Picture box={box} /> : <ShapeArt box={box} />}
            {deck.holdsText(box) && box.text ? (
                <TextLayer box={box}>
                    <Words box={box} />
                </TextLayer>
            ) : null}
        </>
    );
}

/** Below this many pixels a box shows only its corner grips: the side ones would
 *  cover the box itself, and it could no longer be picked up (as in Excalidraw). */
const SIDE_GRIPS_FROM_PX = 56;

/** Below this many pixels the corner grips sit outside the box rather than
 *  across its corners, so a small box still has a middle to press on. */
const OUTSIDE_GRIPS_BELOW_PX = 40;

/** A slide as a picture. Fills the box it is put in, which must be 16:9. */
export function SlideDrawing({ boxes }: { boxes: readonly deck.Box[] }) {
    return (
        <div
            className="pointer-events-none absolute inset-0 select-none [container-type:size]"
            aria-hidden
        >
            {boxes.map((box) =>
                deck.isLine(box) ? (
                    <LineArt key={box.id} box={box} />
                ) : (
                    <div
                        key={box.id}
                        className={cn("absolute", box.kind === "image" && "overflow-hidden")}
                        style={frameStyle(box)}
                    >
                        <BoxBody box={box} />
                    </div>
                )
            )}
        </div>
    );
}

type Draft = deck.BoxFrame & { flip?: boolean; reversed?: boolean };

type Gesture =
    | { kind: "move"; id: string; start: deck.Box; wasChosen: boolean }
    | { kind: "resize"; id: string; start: deck.Box; handle: deck.Handle }
    | { kind: "end"; id: string; start: deck.Box; end: 0 | 1 };

export function SlideStage({
    label,
    boxes,
    chosen,
    editing,
    placeholder,
    nameOf,
    resizeLabel,
    lineEndLabel,
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
    /** What a box is called to a screen reader. */
    nameOf: (box: deck.Box) => string;
    resizeLabel: string;
    lineEndLabel: string;
    onChoose: (id: string) => void;
    onEdit: (id: string) => void;
    onFrame: (id: string, frame: Draft) => void;
    onText: (id: string, text: string) => void;
}) {
    const layer = useRef<HTMLDivElement | null>(null);
    const [draft, setDraft] = useState<{ id: string; frame: Draft } | null>(null);
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
        let last: Draft = gesture.start;
        const smallest = deck.smallestFor(gesture.start);

        const frameAt = (at: {
            clientX: number;
            clientY: number;
            shiftKey: boolean;
            altKey: boolean;
        }): Draft => {
            const dx = (at.clientX - fromX) / bounds.width;
            const dy = (at.clientY - fromY) / bounds.height;
            const start = gesture.start;
            if (gesture.kind === "move") {
                return {
                    ...deck.clampFrame({ ...start, x: start.x + dx, y: start.y + dy }, smallest),
                    flip: start.flip,
                    reversed: start.reversed
                };
            }
            if (gesture.kind === "end") {
                const ends = deck.lineEnds(start);
                const fixed = ends[gesture.end === 0 ? 1 : 0];
                const pulled = ends[gesture.end];
                let to = { x: pulled.x + dx, y: pulled.y + dy };
                // Shift turns the line to the nearest fifteen degrees.
                if (at.shiftKey) to = deck.snapAngle(fixed, to);
                return gesture.end === 0 ? deck.lineThrough(to, fixed) : deck.lineThrough(fixed, to);
            }
            // A picture's corners keep its proportions, and Shift frees them -
            // the other way round from every other box.
            const corner = gesture.handle.length === 2;
            const picture = start.kind === "image" && corner;
            return deck.resizeFrame(start, gesture.handle, dx, dy, {
                keepRatio: picture ? !at.shiftKey : at.shiftKey,
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
            // A click on a box that was already chosen puts the caret in it.
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

    const press = (box: deck.Box, typing: boolean) => (event: ReactPointerEvent) => {
        if (typing) return;
        const wasChosen = chosen === box.id;
        if (!wasChosen) onEdit("");
        onChoose(box.id);
        begin(event, {
            kind: "move",
            id: box.id,
            start: box,
            wasChosen: wasChosen && deck.holdsText(box)
        });
    };

    const drawn = (box: deck.Box): deck.Box =>
        draft?.id === box.id ? { ...box, ...draft.frame } : box;
    const chosenBox = boxes.find((box) => box.id === chosen);
    const chosenDrawn = chosenBox ? drawn(chosenBox) : null;
    // The band round a line that picks it up, in slide units.
    const hitWidth = size.width > 0 ? (LINE_HIT_PX * UNITS_W) / size.width : 0;

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
            {boxes.map((one) => {
                const box = drawn(one);
                const typing = editing === box.id && deck.holdsText(box);
                const line = deck.isLine(box);
                return (
                    <Fragment key={box.id}>
                        {line ? (
                            <LineArt box={box} hitWidth={hitWidth} onPress={press(one, false)} />
                        ) : null}
                        <div
                            data-box={box.id}
                            role="button"
                            tabIndex={0}
                            aria-pressed={chosen === box.id}
                            aria-label={nameOf(box)}
                            onFocus={() => {
                                if (chosen !== box.id) onChoose(box.id);
                            }}
                            onPointerDown={line ? undefined : press(one, typing)}
                            onDoubleClick={() => {
                                if (deck.holdsText(box)) onEdit(box.id);
                            }}
                            className={cn(
                                "absolute outline-none",
                                box.kind === "image" && "overflow-hidden",
                                line && "pointer-events-none",
                                !typing && "cursor-move"
                            )}
                            style={frameStyle(box)}
                        >
                            {line ? null : typing ? (
                                <>
                                    <ShapeArt box={box} />
                                    <TextEditor
                                        box={box}
                                        onDone={(text) => {
                                            onText(box.id, text);
                                            onEdit("");
                                        }}
                                    />
                                </>
                            ) : box.kind === "text" && !box.text.trim() ? (
                                <>
                                    <ShapeArt box={box} />
                                    <TextLayer box={box}>
                                        <div
                                            className="shrink-0 text-muted-foreground"
                                            style={{ ...textStyle(box), color: undefined }}
                                        >
                                            {placeholder}
                                        </div>
                                    </TextLayer>
                                </>
                            ) : (
                                <BoxBody box={box} />
                            )}
                        </div>
                    </Fragment>
                );
            })}

            {chosenDrawn && deck.isLine(chosenDrawn) ? (
                deck.lineEnds(chosenDrawn).map((end, at) => (
                    <span
                        key={at}
                        role="presentation"
                        title={lineEndLabel}
                        onPointerDown={(event) => {
                            event.stopPropagation();
                            begin(event, {
                                kind: "end",
                                id: chosenDrawn.id,
                                start: chosenBox!,
                                end: at === 0 ? 0 : 1
                            });
                        }}
                        className="absolute flex size-5 -translate-x-1/2 -translate-y-1/2 cursor-crosshair items-center justify-center"
                        style={{ left: `${end.x * 100}%`, top: `${end.y * 100}%` }}
                    >
                        <span className="size-2.5 rounded-full border border-primary bg-background shadow-sm" />
                    </span>
                ))
            ) : chosenDrawn ? (
                <div
                    className="pointer-events-none absolute outline outline-2 outline-primary"
                    style={frameStyle(chosenDrawn)}
                >
                    {editing === chosenDrawn.id
                        ? null
                        : deck.HANDLES.filter((handle) => {
                              if (handle.length === 2) return true;
                              const across = chosenDrawn.w * size.width;
                              const down = chosenDrawn.h * size.height;
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
                              const translate = `translate(${shift(across, chosenDrawn.w * size.width)}, ${shift(down, chosenDrawn.h * size.height)})`;
                              return (
                                  <span
                                      key={handle}
                                      role="presentation"
                                      title={resizeLabel}
                                      onPointerDown={(event) => {
                                          event.stopPropagation();
                                          begin(event, {
                                              kind: "resize",
                                              id: chosenDrawn.id,
                                              start: chosenBox!,
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
 * A plain text area laid over the box, uncontrolled: what somebody else changes
 * meanwhile never moves this caret, and the words are written once, as the
 * editing ends - on leaving the box, or Escape. It grows with its words and
 * sits where they sit (top, middle or bottom), so nothing jumps when typing
 * starts or stops.
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
    const fit = (): void => {
        const one = field.current;
        if (!one) return;
        one.style.height = "auto";
        one.style.height = `${one.scrollHeight}px`;
    };
    // Every render, since a bigger size or a list changes the height too.
    useLayoutEffect(fit);
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
        <TextLayer box={box}>
            <textarea
                ref={field}
                defaultValue={box.text}
                spellCheck
                rows={1}
                onInput={fit}
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
                className="block w-full shrink-0 resize-none overflow-hidden bg-transparent p-0 outline-none"
                style={{
                    ...textStyle(box),
                    paddingLeft: box.list === "none" ? undefined : LIST_INDENT
                }}
            />
        </TextLayer>
    );
}
