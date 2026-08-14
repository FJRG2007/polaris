"use client";

/**
 * PowerPoint slide preview. The deck is parsed in the browser (the parser and
 * its unzip library load only when a .pptx is opened) and each slide is drawn at
 * its natural size, then scaled to the dialog width so the layout the author
 * built survives. Read-only: nothing here writes a .pptx back.
 */

import { Loading, ViewerError } from "./status";
import { Button, cn } from "@polaris/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { PptxDeck, PptxParagraph, PptxRun, PptxShape } from "./pptx-parse";

/** Horizontal offset per indent level, in slide pixels. */
const INDENT = 24;

function shapeBox(shape: PptxShape): CSSProperties {
    return {
        position: "absolute",
        left: `${shape.x}px`,
        top: `${shape.y}px`,
        width: `${shape.width}px`,
        height: `${shape.height}px`,
        transform: shape.rotation ? `rotate(${shape.rotation}deg)` : undefined
    };
}

function runStyle(run: PptxRun): CSSProperties {
    return {
        fontSize: run.size ? `${run.size}px` : undefined,
        fontWeight: run.bold ? 700 : undefined,
        fontStyle: run.italic ? "italic" : undefined,
        textDecoration: run.underline ? "underline" : undefined,
        fontFamily: run.font ? `"${run.font}", sans-serif` : undefined,
        color: run.color
    };
}

function Paragraph({ paragraph }: { paragraph: PptxParagraph }) {
    return (
        <p
            style={{
                textAlign: paragraph.align,
                marginLeft: `${paragraph.level * INDENT}px`,
                lineHeight: 1.25,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word"
            }}
        >
            {paragraph.bullet ? <span className="mr-2">{paragraph.bullet}</span> : null}
            {paragraph.runs.map((run, index) => (
                <span key={index} style={runStyle(run)}>
                    {run.text}
                </span>
            ))}
        </p>
    );
}

function Shape({ shape }: { shape: PptxShape }) {
    if (shape.kind === "image") {
        return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
                src={shape.src}
                alt={shape.alt}
                style={{ ...shapeBox(shape), objectFit: "contain" }}
            />
        );
    }

    if (shape.kind === "table") {
        return (
            <table style={{ ...shapeBox(shape), borderCollapse: "collapse", tableLayout: "fixed" }}>
                <colgroup>
                    {shape.columns.map((width, index) => (
                        <col key={index} style={{ width: `${width}px` }} />
                    ))}
                </colgroup>
                <tbody>
                    {shape.rows.map((row, rowIndex) => (
                        <tr key={rowIndex} style={{ height: `${row.height}px` }}>
                            {row.cells.map((cell, cellIndex) => (
                                <td
                                    key={cellIndex}
                                    colSpan={cell.colSpan}
                                    rowSpan={cell.rowSpan}
                                    style={{
                                        background: cell.fill,
                                        border: "1px solid rgba(127, 127, 127, 0.4)",
                                        padding: "4px 8px",
                                        verticalAlign: "middle"
                                    }}
                                >
                                    {cell.paragraphs.map((paragraph, index) => (
                                        <Paragraph key={index} paragraph={paragraph} />
                                    ))}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        );
    }

    return (
        <div
            style={{
                ...shapeBox(shape),
                background: shape.fill,
                border: shape.border,
                display: "flex",
                flexDirection: "column",
                // "safe" keeps text that outgrew its box from being clipped at the
                // top: it falls back to the start edge instead of centering out of
                // view. Nothing is hidden, matching how PowerPoint lets text spill.
                justifyContent: shape.anchor === "start" ? undefined : `safe ${shape.anchor}`,
                paddingTop: `${shape.padding.top}px`,
                paddingRight: `${shape.padding.right}px`,
                paddingBottom: `${shape.padding.bottom}px`,
                paddingLeft: `${shape.padding.left}px`
            }}
        >
            {shape.paragraphs.map((paragraph, index) => (
                <Paragraph key={index} paragraph={paragraph} />
            ))}
        </div>
    );
}

export function PptxView({ src }: { src: string }) {
    const [deck, setDeck] = useState<PptxDeck | null>(null);
    const [error, setError] = useState(false);
    const [index, setIndex] = useState(0);
    const [scale, setScale] = useState(0);
    const frameRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        let alive = true;
        let loaded: PptxDeck | null = null;
        setDeck(null);
        setError(false);
        setIndex(0);
        void (async () => {
            try {
                const [{ parsePptx }, response] = await Promise.all([
                    import("./pptx-parse"),
                    fetch(src)
                ]);
                if (!response.ok) throw new Error("read failed");
                const parsed = await parsePptx(await response.arrayBuffer());
                // Unmounted while parsing: free the pictures instead of leaking them.
                if (!alive) {
                    parsed.release();
                    return;
                }
                loaded = parsed;
                setDeck(parsed);
            } catch {
                if (alive) setError(true);
            }
        })();
        return () => {
            alive = false;
            loaded?.release();
        };
    }, [src]);

    // Slides are drawn at their natural size and scaled to whatever width the
    // dialog gives us, so one measurement drives the whole deck.
    useEffect(() => {
        const frame = frameRef.current;
        if (!frame || !deck) return;
        const observer = new ResizeObserver(([entry]) => {
            const width = entry?.contentRect.width ?? 0;
            if (width > 0) setScale(width / deck.width);
        });
        observer.observe(frame);
        return () => observer.disconnect();
    }, [deck]);

    useEffect(() => {
        if (!deck) return;
        const last = deck.slides.length - 1;
        function onKeyDown(event: KeyboardEvent) {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            const step = event.key === "ArrowRight" ? 1 : -1;
            setIndex((current) => Math.min(Math.max(current + step, 0), last));
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [deck]);

    if (error) return <ViewerError>This presentation could not be rendered.</ViewerError>;
    if (!deck) return <Loading />;

    const slide = deck.slides[index];

    return (
        <div className="flex flex-col gap-3 p-4">
            <div
                ref={frameRef}
                className="w-full overflow-hidden rounded-md border border-border bg-white "
                style={{ height: scale ? `${deck.height * scale}px` : undefined }}
            >
                <div
                    style={{
                        width: `${deck.width}px`,
                        height: `${deck.height}px`,
                        transform: `scale(${scale})`,
                        transformOrigin: "top left",
                        position: "relative",
                        background: slide?.background ?? "#ffffff",
                        color: "#000000",
                        visibility: scale ? "visible" : "hidden"
                    }}
                >
                    {slide?.shapes.map((shape, shapeIndex) => (
                        <Shape key={shapeIndex} shape={shape} />
                    ))}
                </div>
            </div>
            <div className="flex items-center justify-center gap-2">
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === 0}
                    onClick={() => setIndex(index - 1)}
                    aria-label="Previous slide"
                >
                    <ChevronLeft className="size-4" />
                </Button>
                <div className="flex max-w-full items-center gap-1 overflow-x-auto px-1">
                    {deck.slides.map((_, slideIndex) => (
                        <button
                            key={slideIndex}
                            type="button"
                            onClick={() => setIndex(slideIndex)}
                            aria-current={slideIndex === index}
                            className={cn(
                                "size-6 shrink-0 rounded text-xs transition-colors",
                                slideIndex === index
                                    ? "bg-primary text-primary-foreground"
                                    : "text-muted-foreground hover:bg-card-hover"
                            )}
                        >
                            {slideIndex + 1}
                        </button>
                    ))}
                </div>
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === deck.slides.length - 1}
                    onClick={() => setIndex(index + 1)}
                    aria-label="Next slide"
                >
                    <ChevronRight className="size-4" />
                </Button>
            </div>
        </div>
    );
}
