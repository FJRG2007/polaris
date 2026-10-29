"use client";

/**
 * Drawing on a shared screen, the way it is drawn in the room.
 *
 * Somebody watching a share presses the pen on it and the person sharing is
 * asked; once they allow it, strokes drawn over the picture appear on every
 * screen showing that share, and fade a few seconds after the pen comes up.
 * Whoever is sharing can take every pen back at once, and ending the share
 * takes them back too. Inside the desktop app the sharer also sees the strokes
 * on their own display (see the app's `annotate-overlay`); in a browser only
 * the others do, and the strip says so.
 *
 * The wire and the rules are `lib/chat/call-annotate`. This holds the boards,
 * one per share, outside React state: points arrive many times a second and
 * only the canvases need to hear about them.
 */

import { Button, cn } from "@polaris/ui";
import type { CallState } from "./call-state";
import { desktopBridge } from "@/lib/desktop-bridge";
import { Check, Pencil, PenOff, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode
} from "react";
import * as annotation from "@/lib/chat/call-annotate";
import type { Board, Point, StrokeMessage } from "@/lib/chat/call-annotate";

/** How often the points drawn so far are sent while the pen is down. */
const SEND_EVERY_MS = 40;
/** How long a request waits for an answer before the pen offers to ask again:
 *  a sharer with the call put away, or on a version without drawing, never
 *  answers. */
const ASK_WAIT_MS = 30_000;

type AskState = "none" | "asked" | "declined";

interface Annotate {
    readonly me: string | null;
    /** Who this browser lets draw on its own share. */
    readonly allowed: readonly string[];
    /** Who is asking to draw on it, oldest first. */
    readonly asks: readonly string[];
    allow: (seat: string) => void;
    decline: (seat: string) => void;
    stopAll: () => void;
    /** Whether this browser may draw on `owner`'s share. */
    canDraw: (owner: string) => boolean;
    askState: (owner: string) => AskState;
    ask: (owner: string) => void;
    /** The share this browser's pen is on, or null. */
    readonly drawing: string | null;
    setDrawing: (owner: string | null) => void;
    readonly color: number;
    setColor: (color: number) => void;
    /** Points drawn here: onto this board at once and out to the room. */
    draw: (owner: string, id: string, points: readonly Point[], end: boolean) => void;
    board: (owner: string) => Board;
    /** Hear that a board changed. */
    subscribe: (listener: () => void) => () => void;
    /** Whoever holds the seat, named; null for somebody who has just left. */
    readonly nameOf: (seat: string) => string | null;
}

const AnnotateContext = createContext<Annotate | null>(null);

export function AnnotateProvider({ call, children }: { call: CallState; children: ReactNode }) {
    const me = call.participantId;
    const { sendAnnotate, listenAnnotate, setAnnotators, sharing, states } = call;
    const [allowed, setAllowed] = useState<readonly string[]>([]);
    const [asks, setAsks] = useState<readonly string[]>([]);
    const [asked, setAsked] = useState<ReadonlyMap<string, AskState>>(new Map());
    const [drawing, setDrawing] = useState<string | null>(null);
    const [color, setColor] = useState(0);
    const boards = useRef(new Map<string, Board>());
    const listeners = useRef(new Set<() => void>());
    const changed = useCallback(() => {
        for (const listener of listeners.current) listener();
    }, []);

    const board = useCallback((owner: string): Board => {
        let found = boards.current.get(owner);
        if (!found) {
            found = new Map();
            boards.current.set(owner, found);
        }
        return found;
    }, []);

    // What this browser lets happen to its share, said in its attribute.
    useEffect(() => {
        setAnnotators?.(annotation.annotatorsAttribute(allowed));
    }, [allowed, setAnnotators]);

    // A share that ends takes every pen back, and its drawing off the display.
    useEffect(() => {
        if (sharing) return;
        setAllowed([]);
        setAsks([]);
        void desktopBridge()?.stopDrawing?.().catch(() => undefined);
    }, [sharing]);

    const annotatorsOf = useCallback(
        (owner: string): readonly string[] =>
            owner === me ? allowed : (states.get(owner)?.annotators ?? []),
        [allowed, me, states]
    );
    const annotatorsRef = useRef(annotatorsOf);
    annotatorsRef.current = annotatorsOf;
    const allowedRef = useRef(allowed);
    allowedRef.current = allowed;
    const sharingRef = useRef(sharing);
    sharingRef.current = sharing;

    useEffect(() => {
        if (!listenAnnotate) return;
        return listenAnnotate((from, raw) => {
            const parsed = annotation.annotateMessageSchema.safeParse(raw);
            if (!parsed.success) return;
            const message = parsed.data;
            if (message.kind === "draw-ask") {
                // Only a share that is going out can be drawn on.
                if (!sharingRef.current) return;
                if (allowedRef.current.includes(from)) {
                    sendAnnotate?.([from], { kind: "draw-answer", allowed: true });
                    return;
                }
                setAsks((current) => (current.includes(from) ? current : [...current, from].slice(-8)));
                return;
            }
            if (message.kind === "draw-answer") {
                setAsked((current) => {
                    if (current.get(from) !== "asked") return current;
                    const next = new Map(current);
                    next.set(from, message.allowed ? "none" : "declined");
                    return next;
                });
                return;
            }
            if (!annotation.mayDraw(from, message.on, annotatorsRef.current(message.on))) return;
            annotation.addStroke(board(message.on), from, message, Date.now());
            changed();
            if (message.on === me) {
                const desktop = desktopBridge();
                void desktop
                    ?.drawOnShare?.({
                        key: `${from}/${message.id}`,
                        color: annotation.STROKE_COLORS[message.color] ?? annotation.STROKE_COLORS[0],
                        points: message.points,
                        end: message.end
                    })
                    .catch(() => undefined);
            }
        });
    }, [board, changed, listenAnnotate, me, sendAnnotate]);

    // A pen on a share that stopped letting this browser draw is put down.
    const canDraw = useCallback(
        (owner: string) => Boolean(me && sendAnnotate && annotatorsOf(owner).includes(me)),
        [annotatorsOf, me, sendAnnotate]
    );
    if (drawing && !canDraw(drawing)) setDrawing(null);

    const value = useMemo<Annotate>(
        () => ({
            me,
            allowed,
            asks,
            allow: (seat) => {
                setAllowed((current) => (current.includes(seat) ? current : [...current, seat]));
                setAsks((current) => current.filter((entry) => entry !== seat));
                sendAnnotate?.([seat], { kind: "draw-answer", allowed: true });
            },
            decline: (seat) => {
                setAsks((current) => current.filter((entry) => entry !== seat));
                sendAnnotate?.([seat], { kind: "draw-answer", allowed: false });
            },
            stopAll: () => setAllowed([]),
            canDraw,
            askState: (owner) => asked.get(owner) ?? "none",
            ask: (owner) => {
                if (!sendAnnotate) return;
                setAsked((current) => new Map(current).set(owner, "asked"));
                sendAnnotate([owner], { kind: "draw-ask" });
                setTimeout(() => {
                    setAsked((current) => {
                        if (current.get(owner) !== "asked") return current;
                        const next = new Map(current);
                        next.delete(owner);
                        return next;
                    });
                }, ASK_WAIT_MS);
            },
            drawing,
            setDrawing,
            color,
            setColor,
            draw: (owner, id, points, end) => {
                if (!me || points.length === 0) return;
                for (let start = 0; start < points.length; start += annotation.STROKE_POINTS_MAX) {
                    const chunk = points.slice(start, start + annotation.STROKE_POINTS_MAX);
                    const message: StrokeMessage = {
                        kind: "stroke",
                        on: owner,
                        id,
                        color,
                        points: chunk.map(([x, y]) => [x, y] as [number, number]),
                        end: end && start + annotation.STROKE_POINTS_MAX >= points.length
                    };
                    annotation.addStroke(board(owner), me, message, Date.now());
                    sendAnnotate?.(null, message);
                }
                changed();
            },
            board,
            subscribe: (listener) => {
                listeners.current.add(listener);
                return () => listeners.current.delete(listener);
            },
            nameOf: (seat) =>
                call.meeting?.participants.find((person) => person.id === seat)?.name ?? null
        }),
        [allowed, asked, asks, board, call.meeting, canDraw, changed, color, drawing, me, sendAnnotate]
    );

    return <AnnotateContext.Provider value={value}>{children}</AnnotateContext.Provider>;
}

function useAnnotate(): Annotate | null {
    return useContext(AnnotateContext);
}

/**
 * The strokes on one share, over its picture, and the pen when it is down.
 *
 * Laid over the video with the same transform, so a zoomed picture is drawn on
 * where it is shown; points are fractions of the picture itself, worked out
 * from its letterboxed box (`annotation.toPicture`).
 */
export function AnnotateLayer({
    owner,
    aspect,
    transform
}: {
    owner: string;
    /** The picture's width over its height, once known. */
    aspect: number | null;
    transform?: string;
}) {
    const annotate = useAnnotate();
    const canvas = useRef<HTMLCanvasElement>(null);
    const pen = useRef<{ id: string; pending: Point[]; timer: ReturnType<typeof setInterval> | null } | null>(
        null
    );
    const aspectRef = useRef(aspect);
    aspectRef.current = aspect;
    const active = annotate?.drawing === owner;

    useEffect(
        () => () => {
            const current = pen.current;
            if (current?.timer) clearInterval(current.timer);
            pen.current = null;
        },
        [active]
    );

    useEffect(() => {
        const node = canvas.current;
        if (!annotate || !node) return;
        let frame = 0;
        const paint = () => {
            frame = 0;
            const rect = node.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            // The size it is laid out at, not the size it is drawn at: the
            // transform scales the drawing along with the picture.
            const width = node.offsetWidth;
            const height = node.offsetHeight;
            if (node.width !== Math.round(width * ratio)) node.width = Math.round(width * ratio);
            if (node.height !== Math.round(height * ratio)) node.height = Math.round(height * ratio);
            const context = node.getContext("2d");
            if (!context || rect.width <= 0) return;
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
            context.clearRect(0, 0, width, height);
            const now = Date.now();
            const board = annotate.board(owner);
            const left = annotation.pruneBoard(board, now);
            const box = annotation.pictureBox({ left: 0, top: 0, width, height }, aspectRef.current);
            context.lineCap = "round";
            context.lineJoin = "round";
            context.lineWidth = Math.max(2, Math.min(width, height) / 160);
            for (const stroke of board.values()) {
                context.globalAlpha = annotation.strokeAlpha(stroke, now);
                context.strokeStyle = stroke.color;
                context.beginPath();
                stroke.points.forEach(([x, y], index) => {
                    const px = box.left + x * box.width;
                    const py = box.top + y * box.height;
                    if (index === 0) context.moveTo(px, py);
                    else context.lineTo(px, py);
                });
                // A tap is a dot: a line to where it started draws nothing.
                const [first] = stroke.points;
                if (stroke.points.length === 1 && first) {
                    context.lineTo(box.left + first[0] * box.width + 0.1, box.top + first[1] * box.height);
                }
                context.stroke();
            }
            context.globalAlpha = 1;
            // Keep painting while anything is still fading.
            if (left) frame = requestAnimationFrame(paint);
        };
        const schedule = () => {
            if (!frame) frame = requestAnimationFrame(paint);
        };
        const stop = annotate.subscribe(schedule);
        schedule();
        return () => {
            stop();
            if (frame) cancelAnimationFrame(frame);
        };
    }, [annotate, owner]);

    if (!annotate) return null;

    const at = (event: React.PointerEvent<HTMLCanvasElement>): Point | null =>
        annotation.toPicture(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), aspect);

    const flush = (end: boolean) => {
        const current = pen.current;
        if (!current) return;
        const points = current.pending;
        current.pending = [];
        if (points.length > 0 || end) annotate.draw(owner, current.id, points.length > 0 ? points : [], end);
        if (end) {
            if (current.timer) clearInterval(current.timer);
            pen.current = null;
        }
    };

    return (
        <canvas
            ref={canvas}
            aria-hidden
            style={transform ? { transform } : undefined}
            className={cn(
                "absolute inset-0 size-full origin-center",
                active ? "cursor-crosshair touch-none" : "pointer-events-none"
            )}
            onPointerDown={
                active
                    ? (event) => {
                          // The pen, not the zoom's drag.
                          event.stopPropagation();
                          const point = at(event);
                          if (!point) return;
                          event.currentTarget.setPointerCapture(event.pointerId);
                          if (pen.current) flush(true);
                          pen.current = {
                              id: annotation.strokeId(),
                              pending: [point],
                              timer: setInterval(() => flush(false), SEND_EVERY_MS)
                          };
                      }
                    : undefined
            }
            onPointerMove={
                active
                    ? (event) => {
                          if (!pen.current) return;
                          event.stopPropagation();
                          const point = at(event);
                          if (point) pen.current.pending.push(point);
                      }
                    : undefined
            }
            onPointerUp={active ? () => flush(true) : undefined}
            onPointerCancel={active ? () => flush(true) : undefined}
        />
    );
}

const TILE_BUTTON =
    "rounded bg-background/80 p-1 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-60";

/** The pen on somebody else's share: ask, then draw, then put it down. */
export function AnnotateButton({ owner }: { owner: string }) {
    const t = useTranslations("chat");
    const annotate = useAnnotate();
    if (!annotate || !annotate.me || owner === annotate.me) return null;

    if (annotate.canDraw(owner)) {
        const active = annotate.drawing === owner;
        return (
            <>
                {active &&
                    annotation.STROKE_COLORS.map((swatch, index) => (
                        <button
                            key={swatch}
                            type="button"
                            onClick={() => annotate.setColor(index)}
                            aria-pressed={annotate.color === index}
                            aria-label={t("annotate.color", { number: index + 1 })}
                            title={t("annotate.color", { number: index + 1 })}
                            className={cn(
                                "size-5 shrink-0 rounded-full border border-background/80",
                                annotate.color === index && "ring-2 ring-foreground"
                            )}
                            style={{ backgroundColor: swatch }}
                        />
                    ))}
                <button
                    type="button"
                    onClick={() => annotate.setDrawing(active ? null : owner)}
                    aria-pressed={active}
                    aria-label={active ? t("annotate.stopDrawing") : t("annotate.draw")}
                    title={active ? t("annotate.stopDrawing") : t("annotate.draw")}
                    className={cn(TILE_BUTTON, active && "text-primary")}
                >
                    {active ? <PenOff className="size-3.5" /> : <Pencil className="size-3.5" />}
                </button>
            </>
        );
    }

    const state = annotate.askState(owner);
    const label =
        state === "asked"
            ? t("annotate.asked")
            : state === "declined"
              ? t("annotate.declined")
              : t("annotate.askToDraw");
    return (
        <button
            type="button"
            onClick={() => annotate.ask(owner)}
            disabled={state === "asked"}
            aria-label={label}
            title={label}
            className={TILE_BUTTON}
        >
            <Pencil className="size-3.5" />
        </button>
    );
}

/**
 * For the person sharing: who is asking to draw, and who can.
 *
 * A strip in the room rather than a dialog, because allowing a pen on a screen
 * puts nothing of this browser's at risk the way combining audio does: it is a
 * line drawn over a picture, which fades, and which one press takes back.
 */
export function AnnotateStrip() {
    const t = useTranslations("chat");
    const annotate = useAnnotate();
    const [ownOverlay, setOwnOverlay] = useState<"none" | "share" | "shown">("none");
    const asking = (annotate?.asks.length ?? 0) > 0;
    useEffect(() => {
        if (!asking) return;
        const desktop = desktopBridge();
        if (!desktop?.drawOnShare) {
            setOwnOverlay("none");
            return;
        }
        if (!desktop.canDrawOnShare) {
            setOwnOverlay("shown");
            return;
        }
        let live = true;
        desktop.canDrawOnShare().then(
            (drawable) => live && setOwnOverlay(drawable ? "shown" : "share"),
            () => live && setOwnOverlay("share")
        );
        return () => {
            live = false;
        };
    }, [asking]);
    if (!annotate) return null;
    const named = (seat: string) => annotate.nameOf(seat) ?? t("callRoom.somebody");

    return (
        <>
            {annotate.asks.map((seat) => (
                <div
                    key={seat}
                    className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs"
                >
                    <Pencil className="size-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 flex-1">
                        {t("annotate.wantsToDraw", { name: named(seat) })}
                        {ownOverlay !== "shown" && (
                            <span className="block text-muted-foreground">
                                {ownOverlay === "share" ? t("annotate.onlyOthersSeeShare") : t("annotate.onlyOthersSee")}
                            </span>
                        )}
                    </span>
                    <Button size="sm" onClick={() => annotate.allow(seat)}>
                        <Check className="size-3.5" />
                        {t("annotate.allow")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => annotate.decline(seat)}>
                        <X className="size-3.5" />
                        {t("annotate.decline")}
                    </Button>
                </div>
            ))}
            {annotate.allowed.length > 0 && (
                <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
                    <Pencil className="size-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 flex-1">
                        {t("annotate.canDraw", {
                            names: annotate.allowed.map(named).join(", ")
                        })}
                    </span>
                    <Button size="sm" variant="secondary" onClick={annotate.stopAll}>
                        <PenOff className="size-3.5" />
                        {t("annotate.stopAll")}
                    </Button>
                </div>
            )}
        </>
    );
}
