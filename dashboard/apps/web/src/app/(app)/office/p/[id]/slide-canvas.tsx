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
 * modifiers (Shift keeps the proportions, Alt grows from the middle) are the
 * ones whiteboards and PowerPoint use, a picture's corners keep its proportions unless
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
import * as tables from "@/lib/office/slide-table";
import * as motion from "@/lib/office/slide-motion";
import { ChartArt, fontStack, TableArt, UNITS_H, UNITS_W, type CellEditing } from "./slide-objects";
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

/** What each slide is drawn with - its background, its words' colour and
 *  faces - provided by whatever holds the deck; a drawing outside one is a
 *  plain white slide, whatever the app around it looks like. */
const SlideLooks = createContext<(slideId: string) => deck.SlideLook>(() => deck.DEFAULT_LOOK);

export function SlideLookProvider({
    lookOf,
    children
}: {
    lookOf: (slideId: string) => deck.SlideLook;
    children: ReactNode;
}) {
    return <SlideLooks.Provider value={lookOf}>{children}</SlideLooks.Provider>;
}

/** The look of the slide being drawn, for everything inside it. */
const CurrentLook = createContext<deck.SlideLook>(deck.DEFAULT_LOOK);

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
function textStyle(box: deck.Box, look: deck.SlideLook): CSSProperties {
    return {
        fontFamily: fontStack(deck.fontOf(box, look)),
        // A fraction of the slide's height, so words scale with it. `cqh`
        // measures the nearest size container, which is the slide's own layer.
        fontSize: `${box.size * 100}cqh`,
        lineHeight: 1.2,
        color: box.color || look.text,
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
    const style = textStyle(box, useContext(CurrentLook));
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
    // A table draws its own borders and a chart its own marks.
    if (box.kind === "table" || box.kind === "chart") return null;
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
                    <polygon points={`${width / 2},0 ${width},${height} 0,${height}`} {...look} />
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
    const look = useContext(CurrentLook);
    if (box.kind === "table") return <TableArt box={box} look={look} />;
    if (box.kind === "chart") return <ChartArt box={box} look={look} />;
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
 *  cover the box itself, and it could no longer be picked up. */
const SIDE_GRIPS_FROM_PX = 56;

/** Below this many pixels the corner grips sit outside the box rather than
 *  across its corners, so a small box still has a middle to press on. */
const OUTSIDE_GRIPS_BELOW_PX = 40;

/** A slide as a picture. Fills the box it is put in, which must be 16:9. */
export function SlideDrawing({
    boxes,
    slideId,
    states
}: {
    boxes: readonly deck.Box[];
    /** Whose background and theme it is drawn with. */
    slideId: string;
    /** Where each animated thing is at this moment of a show, keyed by what
     *  the animation moves (`motion.targetOf`); everything else at rest. */
    states?: ReadonlyMap<string, motion.MotionState> | null;
}) {
    const look = useContext(SlideLooks)(slideId);
    // A group moves as one: turned and scaled about the middle of all of it.
    const frameOf = (target: string): deck.BoxFrame =>
        deck.boundsOf(motion.membersOf(target, boxes));
    return (
        <div
            className="pointer-events-none absolute inset-0 select-none [container-type:size]"
            style={{ backgroundColor: look.background, color: look.text }}
            aria-hidden
        >
            <CurrentLook.Provider value={look}>
                {boxes.map((box) => {
                    let drawn: ReactNode = deck.isLine(box) ? (
                        <LineArt box={box} />
                    ) : (
                        <div
                            className={cn("absolute", box.kind === "image" && "overflow-hidden")}
                            style={frameStyle(box)}
                        >
                            <BoxBody box={box} />
                        </div>
                    );
                    if (states && states.size > 0) {
                        // The box's own animation inside its group's.
                        const targets = box.group ? [box.id, motion.targetOf(box)] : [box.id];
                        for (const target of targets) {
                            const state = states.get(target);
                            if (!state) continue;
                            drawn = (
                                <div
                                    className="absolute inset-0"
                                    style={motion.motionStyle(state, frameOf(target))}
                                >
                                    {drawn}
                                </div>
                            );
                        }
                    }
                    return <Fragment key={box.id}>{drawn}</Fragment>;
                })}
            </CurrentLook.Provider>
        </div>
    );
}

type Draft = deck.BoxFrame & { flip?: boolean; reversed?: boolean };

type Gesture =
    | {
          kind: "move";
          starts: readonly deck.Box[];
          /** What a press that never became a drag does: puts the caret in
           *  the box, or chooses it alone out of several. */
          click: { id: string; then: "edit" | "alone"; cell?: tables.CellAt } | null;
      }
    | { kind: "resize"; starts: readonly deck.Box[]; handle: deck.Handle }
    | { kind: "end"; starts: readonly deck.Box[]; end: 0 | 1 }
    | { kind: "area"; base: readonly string[] };

export function SlideStage({
    label,
    slideId,
    boxes,
    chosen,
    editing,
    editingCell,
    placeholderOf,
    nameOf,
    resizeLabel,
    lineEndLabel,
    columnLabel,
    onChoose,
    onEdit,
    onFrames,
    onText,
    onCell,
    onTable
}: {
    label: string;
    slideId: string;
    boxes: readonly deck.Box[];
    /** The boxes chosen, in the order they were. */
    chosen: readonly string[];
    editing: string;
    /** The cell being typed into, when what is being typed into is a table. */
    editingCell: tables.CellAt | null;
    /** What an empty text box says while it is being made, never when shown. */
    placeholderOf: (box: deck.Box) => string;
    /** What a box is called to a screen reader. */
    nameOf: (box: deck.Box) => string;
    resizeLabel: string;
    lineEndLabel: string;
    /** What a table's column border is called, to drag it. */
    columnLabel: string;
    onChoose: (ids: string[]) => void;
    /** Typing starts in a box - in a table, in `cell` - or ends, with "". */
    onEdit: (id: string, cell?: tables.CellAt) => void;
    /** Boxes moved or resized - every one that changed, in one go. */
    onFrames: (frames: Map<string, Draft>) => void;
    onText: (id: string, text: string) => void;
    /**
     * A cell's words, as typing in it ends: `then` says what follows - typing
     * stops (`exit`), goes on in the cell now chosen (`stay`), or moves to the
     * next cell or the one before (`next`, `back`).
     */
    onCell: (
        id: string,
        at: tables.CellAt,
        text: string,
        then: "exit" | "stay" | "next" | "back"
    ) => void;
    /** A table's columns resized, worked out from the table as it is when
     *  the edit lands. */
    onTable: (id: string, edit: (table: tables.SlideTable) => tables.SlideTable) => void;
}) {
    const look = useContext(SlideLooks)(slideId);
    const layer = useRef<HTMLDivElement | null>(null);
    const [draft, setDraft] = useState<Map<string, Draft> | null>(null);
    const [guides, setGuides] = useState<readonly deck.Guide[]>([]);
    const [area, setArea] = useState<deck.BoxFrame | null>(null);
    /** A table's columns, while their border is being dragged. */
    const [columns, setColumns] = useState<{ id: string; table: tables.SlideTable } | null>(null);
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
    // What is chosen as of the last press, ahead of the render that shows it:
    // the focus a press moves arrives before that render does.
    const latest = useRef(chosen);
    latest.current = chosen;
    const pressing = useRef(false);

    // A gesture still running when the slide goes away is dropped, never left
    // listening on the window.
    useEffect(() => () => gestureEnd.current?.(), []);

    const choose = (ids: string[]): void => {
        latest.current = ids;
        onChoose(ids);
    };

    const begin = (event: ReactPointerEvent, gesture: Gesture): void => {
        if (event.button !== 0 || !layer.current) return;
        const bounds = layer.current.getBoundingClientRect();
        const fromX = event.clientX;
        const fromY = event.clientY;
        let moved = false;
        let last: Map<string, Draft> = new Map();
        const starts = gesture.kind === "area" ? [] : gesture.starts;
        const moving = new Set(starts.map((box) => box.id));
        const startBounds = deck.boundsOf(starts);
        const targets = deck.snapTargets(boxes.filter((box) => !moving.has(box.id)));
        const tolerance = { x: deck.SNAP_PX / bounds.width, y: deck.SNAP_PX / bounds.height };
        const startX = (fromX - bounds.left) / bounds.width;
        const startY = (fromY - bounds.top) / bounds.height;

        const step = (at: {
            clientX: number;
            clientY: number;
            shiftKey: boolean;
            altKey: boolean;
        }): void => {
            const dx = (at.clientX - fromX) / bounds.width;
            const dy = (at.clientY - fromY) / bounds.height;
            if (gesture.kind === "area") {
                const x = Math.min(1, Math.max(0, startX + dx));
                const y = Math.min(1, Math.max(0, startY + dy));
                const drawn = {
                    x: Math.min(startX, x),
                    y: Math.min(startY, y),
                    w: Math.abs(x - startX),
                    h: Math.abs(y - startY)
                };
                setArea(drawn);
                const picked = deck.inArea(boxes, drawn);
                const next = [
                    ...gesture.base,
                    ...picked.filter((id) => !gesture.base.includes(id))
                ];
                if (next.join() !== latest.current.join()) choose(next);
                return;
            }
            if (gesture.kind === "end") {
                const start = gesture.starts[0]!;
                const ends = deck.lineEnds(start);
                const fixed = ends[gesture.end === 0 ? 1 : 0];
                const pulled = ends[gesture.end];
                let to = { x: pulled.x + dx, y: pulled.y + dy };
                // Shift turns the line to the nearest fifteen degrees.
                if (at.shiftKey) to = deck.snapAngle(fixed, to);
                last = new Map([
                    [
                        start.id,
                        gesture.end === 0
                            ? deck.lineThrough(to, fixed)
                            : deck.lineThrough(fixed, to)
                    ]
                ]);
                setGuides([]);
                return;
            }
            let found: deck.Guide[] = [];
            if (gesture.kind === "move") {
                // The frame round everything moving stays on the slide and
                // snaps as one; Alt lets it go anywhere, as in PowerPoint.
                const room = (from: number, length: number, by: number): number =>
                    Math.min(1 - length, Math.max(0, from + by)) - from;
                let shiftX = room(startBounds.x, startBounds.w, dx);
                let shiftY = room(startBounds.y, startBounds.h, dy);
                if (!at.altKey) {
                    const snapped = deck.snapMove(
                        { ...startBounds, x: startBounds.x + shiftX, y: startBounds.y + shiftY },
                        targets,
                        tolerance
                    );
                    shiftX = room(startBounds.x, startBounds.w, snapped.frame.x - startBounds.x);
                    shiftY = room(startBounds.y, startBounds.h, snapped.frame.y - startBounds.y);
                    found = snapped.guides.filter((guide) =>
                        guide.axis === "x"
                            ? [0, startBounds.w / 2, startBounds.w].some(
                                  (edge) =>
                                      Math.abs(startBounds.x + shiftX + edge - guide.at) < 1e-6
                              )
                            : [0, startBounds.h / 2, startBounds.h].some(
                                  (edge) =>
                                      Math.abs(startBounds.y + shiftY + edge - guide.at) < 1e-6
                              )
                    );
                }
                last = new Map(
                    starts.map((start) => [
                        start.id,
                        {
                            ...deck.clampFrame(
                                { ...start, x: start.x + shiftX, y: start.y + shiftY },
                                deck.smallestFor(start)
                            ),
                            flip: start.flip,
                            reversed: start.reversed
                        }
                    ])
                );
                setGuides(found);
                return;
            }
            const handle = gesture.handle;
            const corner = handle.length === 2;
            if (starts.length === 1) {
                const start = starts[0]!;
                // A picture's corners keep its proportions, and Shift frees
                // them - the other way round from every other box.
                const picture = start.kind === "image" && corner;
                const keepRatio = picture ? !at.shiftKey : at.shiftKey;
                let frame = deck.resizeFrame(start, handle, dx, dy, {
                    keepRatio,
                    fromCenter: at.altKey
                });
                if (!keepRatio && !at.altKey) {
                    const snapped = deck.snapResize(frame, handle, targets, tolerance);
                    frame = deck.clampFrame(snapped.frame);
                    found = snapped.guides;
                }
                last = new Map([[start.id, frame]]);
                setGuides(found);
                return;
            }
            // Several boxes: the frame round them all is resized, and each is
            // put back in the same place inside it.
            const flat = startBounds.w === 0 || startBounds.h === 0;
            let to = deck.resizeFrame(startBounds, handle, dx, dy, {
                keepRatio: at.shiftKey && !flat,
                fromCenter: at.altKey
            });
            if (!at.shiftKey && !at.altKey) {
                const snapped = deck.snapResize(to, handle, targets, tolerance);
                to = deck.clampFrame(snapped.frame);
                found = snapped.guides;
            }
            last = new Map(
                starts.map((start) => [
                    start.id,
                    {
                        ...deck.clampFrame(
                            deck.scaleInto(start, startBounds, to),
                            deck.smallestFor(start)
                        ),
                        flip: start.flip,
                        reversed: start.reversed
                    }
                ])
            );
            setGuides(found);
        };
        const move = (at: PointerEvent): void => {
            if (!moved && Math.hypot(at.clientX - fromX, at.clientY - fromY) < DRAG_THRESHOLD_PX)
                return;
            moved = true;
            step(at);
            if (gesture.kind !== "area") setDraft(last);
        };
        const finish = (commit: boolean): void => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", cancel);
            window.removeEventListener("keydown", escape, true);
            gestureEnd.current = null;
            pressing.current = false;
            setDraft(null);
            setGuides([]);
            setArea(null);
            if (gesture.kind === "area") {
                if (!commit) choose([...gesture.base]);
                return;
            }
            if (!commit) return;
            if (moved) {
                if (last.size > 0) onFrames(last);
                return;
            }
            if (gesture.kind !== "move" || !gesture.click) return;
            // A click on a box that was already chosen puts the caret in it;
            // on one of several chosen, it chooses that one alone.
            if (gesture.click.then === "edit") onEdit(gesture.click.id, gesture.click.cell);
            else choose([gesture.click.id]);
        };
        const up = (): void => finish(true);
        const cancel = (): void => finish(false);
        // Escape mid-drag puts everything back where it was, as in every editor.
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

    const byId = (ids: readonly string[]): deck.Box[] =>
        boxes.filter((box) => ids.includes(box.id));

    /** The cell of a table a press landed on, if it landed on one. */
    const cellAt = (target: EventTarget | null): tables.CellAt | undefined => {
        if (!(target instanceof Element)) return undefined;
        const found = target.closest<HTMLElement>("[data-cell]")?.dataset.cell;
        const [row, col] = (found ?? "").split(":").map(Number);
        return Number.isInteger(row) && Number.isInteger(col)
            ? { row: row as number, col: col as number }
            : undefined;
    };

    const press = (box: deck.Box, typing: boolean) => (event: ReactPointerEvent) => {
        if (typing || event.button !== 0) return;
        pressing.current = true;
        const current = latest.current;
        const unit = deck.unitOf(boxes, box.id);
        // Shift (or Ctrl) adds what was pressed to the boxes chosen, or takes
        // it away again - Google Slides' and PowerPoint's.
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
            onEdit("");
            const has = current.includes(box.id);
            const next = has
                ? current.filter((id) => !unit.includes(id))
                : [...current, ...unit.filter((id) => !current.includes(id))];
            choose(next);
            if (has) {
                // No drag follows to say when the press is over.
                window.addEventListener(
                    "pointerup",
                    () => {
                        pressing.current = false;
                    },
                    { once: true }
                );
                return;
            }
            begin(event, { kind: "move", starts: byId(next), click: null });
            return;
        }
        if (current.includes(box.id)) {
            const alone = current.length === 1;
            begin(event, {
                kind: "move",
                starts: byId(current),
                click: alone
                    ? deck.typable(box)
                        ? { id: box.id, then: "edit", cell: cellAt(event.target) }
                        : null
                    : { id: box.id, then: "alone" }
            });
            return;
        }
        onEdit("");
        choose(unit);
        begin(event, { kind: "move", starts: byId(unit), click: null });
    };

    const drawn = (box: deck.Box): deck.Box => {
        const frame = draft?.get(box.id);
        const sized = columns?.id === box.id ? { ...box, table: columns.table } : box;
        return frame ? { ...sized, ...frame } : sized;
    };

    /** A table's column border dragged: the two columns either side of it
     *  trade width, written once on release. */
    const dragColumn = (event: ReactPointerEvent, box: deck.Box, border: number): void => {
        event.stopPropagation();
        const start = box.table;
        if (event.button !== 0 || !start || !layer.current) return;
        const across = layer.current.getBoundingClientRect().width * box.w;
        const fromX = event.clientX;
        let last = start;
        let by = 0;
        const move = (at: PointerEvent): void => {
            by = (at.clientX - fromX) / Math.max(1, across);
            last = tables.resizeCol(start, border, by);
            setColumns({ id: box.id, table: last });
        };
        const finish = (commit: boolean): void => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", cancel);
            window.removeEventListener("keydown", escape, true);
            gestureEnd.current = null;
            setColumns(null);
            if (commit && last !== start)
                onTable(box.id, (one) => tables.resizeCol(one, border, by));
        };
        const up = (): void => finish(true);
        const cancel = (): void => finish(false);
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
    /** What typing in a table's cells does, for the table being typed in. */
    const cellEditing = (box: deck.Box): CellEditing => {
        const at = box.table
            ? tables.clampCell(box.table, editingCell ?? { row: 0, col: 0 })
            : { row: 0, col: 0 };
        return {
            at,
            onDone: (text) => onCell(box.id, at, text, "exit"),
            onKeep: (text) => onCell(box.id, at, text, "stay"),
            onMove: (text, back) => onCell(box.id, at, text, back ? "back" : "next"),
            onPick: (next) => onEdit(box.id, next)
        };
    };

    const chosenBoxes = boxes.filter((box) => chosen.includes(box.id)).map(drawn);
    const single = chosenBoxes.length === 1 ? chosenBoxes[0]! : null;
    const handlesFor = chosenBoxes.length > 0 ? deck.boundsOf(chosenBoxes) : null;
    // The band round a line that picks it up, in slide units.
    const hitWidth = size.width > 0 ? (LINE_HIT_PX * UNITS_W) / size.width : 0;
    const resizing = (event: ReactPointerEvent, handle: deck.Handle): void => {
        event.stopPropagation();
        begin(event, { kind: "resize", starts: byId(chosen), handle });
    };

    return (
        <div
            ref={layer}
            role="group"
            aria-label={label}
            tabIndex={-1}
            className="absolute inset-0 touch-none select-none outline-none [container-type:size]"
            style={{ backgroundColor: look.background, color: look.text }}
            onPointerDown={(event) => {
                // A press on the slide itself, between boxes, lets go of what
                // was chosen and starts a selection rectangle - one with Shift
                // adds to what was chosen.
                if (event.target !== event.currentTarget || event.button !== 0) return;
                onEdit("");
                const base = event.shiftKey || event.ctrlKey || event.metaKey ? latest.current : [];
                choose([...base]);
                event.currentTarget.focus();
                begin(event, { kind: "area", base });
            }}
        >
            <CurrentLook.Provider value={look}>
                {boxes.map((one) => {
                    const box = drawn(one);
                    const typing = editing === box.id && deck.typable(box);
                    const line = deck.isLine(box);
                    const empty = box.kind === "text" && !box.text.trim();
                    return (
                        <Fragment key={box.id}>
                            {line ? (
                                <LineArt
                                    box={box}
                                    hitWidth={hitWidth}
                                    onPress={press(one, false)}
                                />
                            ) : null}
                            <div
                                data-box={box.id}
                                role="button"
                                tabIndex={0}
                                aria-pressed={chosen.includes(box.id)}
                                aria-label={nameOf(box)}
                                onFocus={() => {
                                    // Tabbed to, a box is chosen with its group;
                                    // pressed, the press already chose.
                                    if (pressing.current || latest.current.includes(box.id)) return;
                                    choose(deck.unitOf(boxes, box.id));
                                }}
                                onPointerDown={line ? undefined : press(one, typing)}
                                onDoubleClick={(event) => {
                                    if (!deck.typable(box)) return;
                                    choose([box.id]);
                                    onEdit(box.id, cellAt(event.target));
                                }}
                                className={cn(
                                    "absolute outline-none",
                                    box.kind === "image" && "overflow-hidden",
                                    line && "pointer-events-none",
                                    !typing && "cursor-move"
                                )}
                                style={frameStyle(box)}
                            >
                                {line ? null : typing && box.kind === "table" ? (
                                    <TableArt box={box} look={look} editing={cellEditing(box)} />
                                ) : typing ? (
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
                                ) : empty ? (
                                    <>
                                        <ShapeArt box={box} />
                                        {/* An empty box is outlined while the
                                            deck is being made, as Google Slides
                                            outlines its placeholders, so it can
                                            be found to type into. */}
                                        <span
                                            aria-hidden
                                            className="pointer-events-none absolute inset-0 border border-dashed"
                                            style={{
                                                borderColor: `color-mix(in srgb, ${look.text} 30%, transparent)`
                                            }}
                                        />
                                        <TextLayer box={box}>
                                            <div
                                                className="shrink-0"
                                                style={{
                                                    ...textStyle(box, look),
                                                    color: `color-mix(in srgb, ${box.color || look.text} 50%, transparent)`
                                                }}
                                            >
                                                {placeholderOf(box)}
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
            </CurrentLook.Provider>

            {chosenBoxes.length > 1
                ? chosenBoxes.map((box) =>
                      deck.isLine(box) ? (
                          <LineHighlight key={box.id} box={box} />
                      ) : (
                          <div
                              key={box.id}
                              className="pointer-events-none absolute outline outline-1 outline-primary/70"
                              style={frameStyle(box)}
                          />
                      )
                  )
                : null}

            {single && deck.isLine(single) ? (
                deck.lineEnds(single).map((end, at) => (
                    <span
                        key={at}
                        role="presentation"
                        title={lineEndLabel}
                        onPointerDown={(event) => {
                            event.stopPropagation();
                            begin(event, {
                                kind: "end",
                                starts: byId([single.id]),
                                end: at === 0 ? 0 : 1
                            });
                        }}
                        className="absolute flex size-5 -translate-x-1/2 -translate-y-1/2 cursor-crosshair items-center justify-center"
                        style={{ left: `${end.x * 100}%`, top: `${end.y * 100}%` }}
                    >
                        <span className="size-2.5 rounded-full border border-primary bg-background shadow-sm" />
                    </span>
                ))
            ) : handlesFor ? (
                <div
                    className={cn(
                        "pointer-events-none absolute outline outline-2 outline-primary",
                        chosenBoxes.length > 1 && "outline-dashed outline-1"
                    )}
                    style={frameStyle(handlesFor)}
                >
                    {single && editing === single.id ? null : (
                        <Grips
                            frame={handlesFor}
                            size={size}
                            title={resizeLabel}
                            onPress={resizing}
                        />
                    )}
                    {single?.table && editing !== single.id
                        ? tables
                              .colBorders(single.table)
                              .map((at, border) => (
                                  <span
                                      key={border}
                                      role="presentation"
                                      title={columnLabel}
                                      onPointerDown={(event) => dragColumn(event, single, border)}
                                      className="pointer-events-auto absolute inset-y-0 w-2 -translate-x-1/2 cursor-col-resize"
                                      style={{ left: `${at * 100}%` }}
                                  />
                              ))
                        : null}
                </div>
            ) : null}

            {guides.map((guide, at) => (
                <span
                    key={`${guide.axis}${at}`}
                    aria-hidden
                    className="pointer-events-none absolute bg-rose-500"
                    style={
                        guide.axis === "x"
                            ? { left: `${guide.at * 100}%`, top: 0, bottom: 0, width: 1 }
                            : { top: `${guide.at * 100}%`, left: 0, right: 0, height: 1 }
                    }
                />
            ))}

            {area ? (
                <span
                    aria-hidden
                    className="pointer-events-none absolute border border-primary bg-primary/10"
                    style={frameStyle(area)}
                />
            ) : null}
        </div>
    );
}

/** A line among several chosen, marked along its length. */
function LineHighlight({ box }: { box: deck.Box }) {
    const [start, end] = deck.lineEnds(box);
    return (
        <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            viewBox={`0 0 ${UNITS_W} ${UNITS_H}`}
            preserveAspectRatio="none"
        >
            <line
                x1={start.x * UNITS_W}
                y1={start.y * UNITS_H}
                x2={end.x * UNITS_W}
                y2={end.y * UNITS_H}
                className="stroke-primary"
                strokeOpacity={0.7}
                strokeWidth={Math.max(2, box.strokeWidth * UNITS_H + 4)}
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    );
}

/** The grips round what is chosen - one box, or the frame round several. */
function Grips({
    frame,
    size,
    title,
    onPress
}: {
    frame: deck.BoxFrame;
    size: { width: number; height: number };
    title: string;
    onPress: (event: ReactPointerEvent, handle: deck.Handle) => void;
}) {
    const across = frame.w * size.width;
    const down = frame.h * size.height;
    return (
        <>
            {deck.HANDLES.filter((handle) => {
                if (handle.length === 2) return true;
                return handle === "n" || handle === "s"
                    ? across >= SIDE_GRIPS_FROM_PX
                    : down >= SIDE_GRIPS_FROM_PX;
            }).map((handle) => {
                const [x, y] = HANDLE_AT[handle];
                const shift = (at: number, room: number): string =>
                    at === 0.5 || room >= OUTSIDE_GRIPS_BELOW_PX
                        ? "-50%"
                        : at === 0
                          ? "-100%"
                          : "0%";
                return (
                    <span
                        key={handle}
                        role="presentation"
                        title={title}
                        onPointerDown={(event) => onPress(event, handle)}
                        className="pointer-events-auto absolute flex size-5 items-center justify-center"
                        style={{
                            left: `${x * 100}%`,
                            top: `${y * 100}%`,
                            transform: `translate(${shift(x, across)}, ${shift(y, down)})`,
                            cursor: HANDLE_CURSOR[handle]
                        }}
                    >
                        <span className="size-2.5 rounded-sm border border-primary bg-background shadow-sm" />
                    </span>
                );
            })}
        </>
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
    const look = useContext(CurrentLook);
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
                    ...textStyle(box, look),
                    paddingLeft: box.list === "none" ? undefined : LIST_INDENT
                }}
            />
        </TextLayer>
    );
}
