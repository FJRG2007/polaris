"use client";

/**
 * The two things on a slide that are not words in a frame or a picture: a
 * table and a chart, drawn.
 *
 * Both are drawn in the slide's own measures - a table's words in `cqh` like
 * every other box's, a chart in slide units (the slide is 1600 by 900) - so
 * the thumbnail, the canvas and the show are one drawing at three sizes.
 */

import * as deck from "@/lib/office/deck";
import * as tables from "@/lib/office/slide-table";
import * as charts from "@/lib/office/slide-chart";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    type CSSProperties,
    type ReactNode
} from "react";

/** The slide, in the units shapes, lines and charts are drawn in. */
export const UNITS_W = 1600;
export const UNITS_H = 900;

/** A face, with the kind of face to fall back on where it is missing. */
export function fontStack(font: string): string {
    const kind =
        font === "Courier New"
            ? "monospace"
            : font === "Georgia" || font === "Times New Roman"
              ? "serif"
              : "sans-serif";
    return `"${font}", ${kind}`;
}

const JUSTIFY: Readonly<Record<deck.Box["valign"], CSSProperties["justifyContent"]>> = {
    top: "flex-start",
    middle: "center",
    bottom: "flex-end"
};

/** What a cell's words look like: the table's face, size, emphasis and
 *  alignment, in the colour `color`. */
function cellStyle(
    box: deck.Box,
    look: deck.SlideLook,
    color: string,
    bold: boolean
): CSSProperties {
    return {
        fontFamily: fontStack(deck.fontOf(box, look)),
        fontSize: `${box.size * 100}cqh`,
        lineHeight: 1.2,
        color,
        textAlign: box.align,
        fontWeight: bold ? 700 : undefined,
        fontStyle: box.italic ? "italic" : undefined,
        textDecorationLine: box.underline ? "underline" : undefined
    };
}

/** Where cell `at` of a table is being typed into, and what to do as it is. */
export interface CellEditing {
    readonly at: tables.CellAt;
    /** The words, written as typing leaves the table - the cell left, Escape. */
    readonly onDone: (text: string) => void;
    /** The words, written as typing moves to another cell of the same table. */
    readonly onKeep: (text: string) => void;
    /** Tab and Shift+Tab: the words written and the next cell chosen. */
    readonly onMove: (text: string, back: boolean) => void;
    /** Another cell pressed while typing. */
    readonly onPick: (at: tables.CellAt) => void;
}

/**
 * A table, drawn: a grid as wide as its columns say and at least as tall as
 * its box - a row with more words than room grows, as in PowerPoint, rather
 * than hiding them. The header row is filled with the box's fill, the bands
 * with a tint of it, and the borders are the box's outline.
 */
export function TableArt({
    box,
    look,
    editing
}: {
    box: deck.Box;
    look: deck.SlideLook;
    editing?: CellEditing | null;
}) {
    const table = box.table;
    if (!table) return null;
    const count = table.rows.length;
    const fill = box.fill && box.fill !== "transparent" ? box.fill : "";
    const border =
        box.stroke && box.stroke !== "transparent"
            ? `max(1px, ${box.strokeWidth * 100}cqh) solid ${box.stroke}`
            : undefined;
    const ink = box.color || look.text;
    const headerInk = fill ? (charts.isDark(fill) ? "#ffffff" : "#1f2328") : ink;
    return (
        <div
            className="absolute inset-x-0 top-0 grid min-h-full"
            style={{
                gridTemplateColumns: table.cols.map((one) => `minmax(0, ${one}fr)`).join(" "),
                gridTemplateRows: `repeat(${count}, minmax(${100 / count}%, auto))`,
                borderTop: border,
                borderLeft: border
            }}
        >
            {table.rows.map((row, r) =>
                row.map((cell, c) => {
                    const header = table.header && r === 0;
                    const banded =
                        table.banded && !header && (r - (table.header ? 1 : 0)) % 2 === 1;
                    const typing = editing && editing.at.row === r && editing.at.col === c;
                    return (
                        <div
                            key={`${r}:${c}`}
                            data-cell={`${r}:${c}`}
                            className="flex min-w-0 flex-col"
                            style={{
                                justifyContent: JUSTIFY[box.valign],
                                padding: "0.6cqh 1cqh",
                                borderRight: border,
                                borderBottom: border,
                                backgroundColor:
                                    header && fill
                                        ? fill
                                        : banded && fill
                                          ? `color-mix(in srgb, ${fill} 14%, transparent)`
                                          : undefined
                            }}
                            onPointerDown={
                                editing && !typing
                                    ? (event) => {
                                          event.stopPropagation();
                                          editing.onPick({ row: r, col: c });
                                      }
                                    : undefined
                            }
                            // The press would otherwise take the focus away
                            // from the cell it just opened for typing - which,
                            // by the time the mouse's own event arrives, is
                            // this one. Inside the field it places the caret.
                            onMouseDown={
                                editing
                                    ? (event) => {
                                          if (!(event.target instanceof HTMLTextAreaElement))
                                              event.preventDefault();
                                      }
                                    : undefined
                            }
                        >
                            {typing ? (
                                <CellEditor
                                    key={`${r}:${c}`}
                                    text={cell}
                                    style={cellStyle(
                                        box,
                                        look,
                                        header ? headerInk : ink,
                                        box.bold || header
                                    )}
                                    editing={editing}
                                />
                            ) : (
                                <div
                                    className="whitespace-pre-wrap break-words"
                                    style={cellStyle(
                                        box,
                                        look,
                                        header ? headerInk : ink,
                                        box.bold || header
                                    )}
                                >
                                    {cell || "​"}
                                </div>
                            )}
                        </div>
                    );
                })
            )}
        </div>
    );
}

/**
 * One cell's words, being typed: uncontrolled, like a text box's, and written
 * once as the typing in the cell ends - on leaving it, on Tab to the next, on
 * Escape. A cell taken away without a blur keeps its words too.
 */
function CellEditor({
    text,
    style,
    editing
}: {
    text: string;
    style: CSSProperties;
    editing: CellEditing;
}) {
    const field = useRef<HTMLTextAreaElement | null>(null);
    const latest = useRef(editing);
    latest.current = editing;
    const finished = useRef(false);
    const fit = (): void => {
        const one = field.current;
        if (!one) return;
        one.style.height = "auto";
        one.style.height = `${one.scrollHeight}px`;
    };
    useLayoutEffect(fit);
    useEffect(() => {
        const one = field.current;
        if (!one) return;
        one.focus();
        one.setSelectionRange(one.value.length, one.value.length);
        return () => {
            if (!finished.current) {
                finished.current = true;
                latest.current.onKeep(one.value);
            }
        };
    }, []);
    return (
        <textarea
            ref={field}
            defaultValue={text}
            spellCheck
            rows={1}
            maxLength={tables.CELL_MAX}
            onInput={fit}
            onBlur={(event) => {
                // Taken out of the page because another cell was pressed:
                // typing goes on there, and the unmount below keeps the words.
                if (finished.current || !event.currentTarget.isConnected) return;
                finished.current = true;
                latest.current.onDone(event.currentTarget.value);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
                if (event.key === "Tab") {
                    event.preventDefault();
                    event.stopPropagation();
                    if (finished.current) return;
                    finished.current = true;
                    latest.current.onMove(event.currentTarget.value, event.shiftKey);
                    return;
                }
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                const host = event.currentTarget.closest<HTMLElement>("[data-box]");
                event.currentTarget.blur();
                host?.focus();
            }}
            className="block w-full shrink-0 resize-none overflow-hidden bg-transparent p-0 outline-none"
            style={style}
        />
    );
}

/** A bar's outline, rounded at the end away from the axis it stands on. */
function barPath(bar: charts.BarMark, across: boolean, radius: number): string {
    const r = Math.max(0, Math.min(radius, (across ? bar.h : bar.w) / 2, across ? bar.w : bar.h));
    const { x, y, w, h } = bar;
    if (r <= 0) return `M ${x} ${y} h ${w} v ${h} h ${-w} Z`;
    if (across) {
        // Horizontal: the far end is the right one, or the left for a value
        // below zero.
        return bar.value >= 0
            ? `M ${x} ${y} h ${w - r} a ${r} ${r} 0 0 1 ${r} ${r} v ${h - 2 * r} a ${r} ${r} 0 0 1 ${-r} ${r} h ${-(w - r)} Z`
            : `M ${x + w} ${y} h ${-(w - r)} a ${r} ${r} 0 0 0 ${-r} ${r} v ${h - 2 * r} a ${r} ${r} 0 0 0 ${r} ${r} h ${w - r} Z`;
    }
    return bar.value >= 0
        ? `M ${x} ${y + h} v ${-(h - r)} a ${r} ${r} 0 0 1 ${r} ${-r} h ${w - 2 * r} a ${r} ${r} 0 0 1 ${r} ${r} v ${h - r} Z`
        : `M ${x} ${y} v ${h - r} a ${r} ${r} 0 0 0 ${r} ${r} h ${w - 2 * r} a ${r} ${r} 0 0 0 ${r} ${-r} v ${-(h - r)} Z`;
}

function Label({ text, fill }: { text: charts.ChartText; fill: string }) {
    return (
        <text
            x={text.x}
            y={text.y}
            textAnchor={text.anchor}
            dominantBaseline={text.middle ? "central" : undefined}
            fill={fill}
        >
            {text.text}
        </text>
    );
}

/**
 * A chart, drawn from its numbers. Recessive grid and axis, thin marks, a 2-unit
 * gap of the slide's own colour between neighbouring bars and round the slices,
 * the key below when there is more than one thing to tell apart. Words are in
 * the slide's text colour, never a series colour.
 */
export function ChartArt({ box, look }: { box: deck.Box; look: deck.SlideLook }) {
    const chart = box.chart;
    const width = Math.max(1, box.w * UNITS_W);
    const height = Math.max(1, box.h * UNITS_H);
    const font = box.size * UNITS_H;
    const t = useTranslations("office");
    const other = t("slides.chart.other");
    const layout = useMemo(
        () => (chart ? charts.chartLayout(chart, width, height, font, undefined, other) : null),
        [chart, width, height, font, other]
    );
    if (!chart || !layout) return null;
    const ink = box.color || look.text;
    const faint = `color-mix(in srgb, ${ink} 18%, transparent)`;
    const muted = `color-mix(in srgb, ${ink} 70%, transparent)`;
    const color = (index: number) => charts.seriesColor(index, look.background);
    const gap = 2;
    let marks: ReactNode = null;
    if (chart.kind === "pie") {
        marks = layout.slices.map((slice) => (
            <path
                key={slice.category}
                d={slice.path}
                fill={color(slice.category)}
                stroke={look.background}
                strokeWidth={gap}
                strokeLinejoin="round"
            />
        ));
    } else if (chart.kind === "column" || chart.kind === "bar") {
        marks = layout.bars.map((bar) => (
            <path
                key={`${bar.series}:${bar.category}`}
                d={barPath(bar, chart.kind === "bar", 4)}
                fill={color(bar.series)}
            />
        ));
    } else {
        const stroke = Math.max(2, font * 0.14);
        marks = layout.lines.map((line) => (
            <g key={line.series}>
                {chart.kind === "area" ? (
                    <path d={line.area} fill={color(line.series)} fillOpacity={0.28} />
                ) : null}
                <polyline
                    points={line.points.map((point) => `${point.x},${point.y}`).join(" ")}
                    fill="none"
                    stroke={color(line.series)}
                    strokeWidth={stroke}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
                {chart.kind === "line"
                    ? line.points.map((point, at) => (
                          <circle
                              key={at}
                              cx={point.x}
                              cy={point.y}
                              r={Math.max(4, font * 0.24)}
                              fill={color(line.series)}
                              stroke={look.background}
                              strokeWidth={gap}
                          />
                      ))
                    : null}
            </g>
        ));
    }
    return (
        <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            style={{ fontFamily: fontStack(deck.fontOf(box, look)), fontSize: font }}
        >
            {layout.grid.map((line, at) => (
                <g key={at}>
                    <line
                        x1={line.from.x}
                        y1={line.from.y}
                        x2={line.to.x}
                        y2={line.to.y}
                        stroke={faint}
                        strokeWidth={1}
                    />
                    <Label text={line.label} fill={muted} />
                </g>
            ))}
            {layout.zero ? (
                <line
                    x1={layout.zero.from.x}
                    y1={layout.zero.from.y}
                    x2={layout.zero.to.x}
                    y2={layout.zero.to.y}
                    stroke={muted}
                    strokeWidth={1.5}
                />
            ) : null}
            {marks}
            {layout.categoryLabels.map((label, at) => (
                <Label key={at} text={label} fill={muted} />
            ))}
            {layout.valueLabels.map((label, at) => {
                // A pie's labels sit on their slices, in whichever of black and
                // white reads on that slice's colour.
                const slice = chart.kind === "pie" ? layout.slices[at] : undefined;
                const on = slice ? color(slice.category) : "";
                return (
                    <Label
                        key={at}
                        text={label}
                        fill={slice ? (charts.isDark(on) ? "#ffffff" : "#1f2328") : ink}
                    />
                );
            })}
            {layout.legend.map((item) => (
                <g key={item.color}>
                    <rect
                        x={item.x}
                        y={item.y - layout.swatch / 2}
                        width={layout.swatch}
                        height={layout.swatch}
                        rx={layout.swatch * 0.2}
                        fill={color(item.color)}
                    />
                    <text
                        x={item.x + layout.swatch + font * 0.4}
                        y={item.y}
                        dominantBaseline="central"
                        fill={ink}
                    >
                        {item.label}
                    </text>
                </g>
            ))}
        </svg>
    );
}
