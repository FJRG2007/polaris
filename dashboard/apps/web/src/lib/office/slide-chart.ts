/**
 * A chart on a slide.
 *
 * What PowerPoint and Google Slides keep behind one: a kind, the categories
 * along it and one or more series of numbers - the small sheet their "Edit
 * data" opens. The picture is worked out from that every time it is drawn
 * (`chartLayout`), so the thumbnail, the canvas, the show and the exported file
 * all come from the same numbers rather than from a picture of them.
 *
 * The geometry is pure and in the box's own units - the slide is 1600 by 900 -
 * so it is the same chart at every size and can be tested without a screen.
 *
 * The series colours are a fixed, validated categorical order, assigned by
 * the series' place and never cycled: there are as many series as colours and
 * no more. Two orders, one stepped for light slides and one for dark, because a
 * colour that reads on white is not the one that reads on navy.
 */

export const CHART_KINDS = ["column", "bar", "line", "area", "pie"] as const;

export type ChartKind = (typeof CHART_KINDS)[number];

/** As many series as there are colours to tell them apart. */
export const SERIES_MAX = 8;
/** As many categories as a slide can still label. */
export const CATEGORIES_MAX = 40;
/** The longest a category or series name may be. */
export const NAME_MAX = 120;

export interface ChartSeries {
    readonly name: string;
    /** One per category; a value nobody gave is 0. */
    readonly values: readonly number[];
}

export interface SlideChart {
    readonly kind: ChartKind;
    readonly categories: readonly string[];
    readonly series: readonly ChartSeries[];
    /** The key naming what each colour is. */
    readonly legend: boolean;
    /** Each value written beside its mark. */
    readonly labels: boolean;
}

/** The series colours, in the order series take them, for light slides and
 *  for dark ones. Checked for colour-blind separation as a set. */
export const SERIES_COLORS = {
    light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
    dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"]
} as const;

/** Whether a colour is dark, by its relative luminance - what decides the
 *  series colours and the colour of words on a fill. */
export function isDark(hex: string): boolean {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(hex);
    if (!match) return false;
    const digits = match[1]!;
    const full =
        digits.length === 3
            ? digits
                  .split("")
                  .map((one) => one + one)
                  .join("")
            : digits;
    const channel = (at: number): number => {
        const value = parseInt(full.slice(at, at + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
    return luminance < 0.4;
}

/** The colour of series number `index` on a slide of `background`. */
export function seriesColor(index: number, background: string): string {
    const set = isDark(background) ? SERIES_COLORS.dark : SERIES_COLORS.light;
    return set[index % set.length]!;
}

function finiteNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function name(value: unknown): string {
    return typeof value === "string" ? value.slice(0, NAME_MAX) : "";
}

/** A chart as stored, made whole: a kind it knows, between one and the most
 *  categories and series, every series as long as the categories. */
export function readChart(raw: unknown): SlideChart {
    const one = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const kind = CHART_KINDS.includes(one.kind as ChartKind) ? (one.kind as ChartKind) : "column";
    const storedCategories = Array.isArray(one.categories)
        ? one.categories.slice(0, CATEGORIES_MAX)
        : [];
    const categories = (storedCategories.length > 0 ? storedCategories : [""]).map(name);
    const storedSeries = Array.isArray(one.series) ? one.series.slice(0, SERIES_MAX) : [];
    const series = (storedSeries.length > 0 ? storedSeries : [{}]).map((raw) => {
        const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const values = Array.isArray(entry.values) ? entry.values : [];
        return {
            name: name(entry.name),
            values: categories.map((_, at) => finiteNumber(values[at]))
        };
    });
    return {
        kind,
        categories,
        series,
        legend: one.legend !== false,
        labels: one.labels === true
    };
}

/**
 * A chart to start from, as PowerPoint and Google Slides insert one: a few
 * categories and made-up numbers that show what the kind looks like, ready for
 * "Edit data". A pie shows one series - it can only ever show the first.
 */
export function sampleChart(
    kind: ChartKind,
    names: { readonly category: (n: number) => string; readonly series: (n: number) => string }
): SlideChart {
    const categories = [1, 2, 3, 4].map(names.category);
    const values = [
        [4.3, 2.5, 3.5, 4.5],
        [2.4, 4.4, 1.8, 2.8],
        [2, 2, 3, 5]
    ];
    const count = kind === "pie" ? 1 : 3;
    return {
        kind,
        categories,
        series: values
            .slice(0, count)
            .map((one, at) => ({ name: names.series(at + 1), values: one })),
        legend: true,
        labels: kind === "pie"
    };
}

/** Whether a chart shows its key: asked to, and there being more than one
 *  thing to tell apart - a pie's slices, or two series or more. */
export function showsLegend(chart: SlideChart): boolean {
    return (
        chart.legend &&
        (chart.kind === "pie" ? chart.categories.length > 1 : chart.series.length > 1)
    );
}

// ---------------------------------------------------------------------------
// Axis
// ---------------------------------------------------------------------------

/** A number that reads well on an axis: 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(rough: number): number {
    if (!(rough > 0)) return 1;
    const power = 10 ** Math.floor(Math.log10(rough));
    const fraction = rough / power;
    const nice =
        fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
    return nice * power;
}

/**
 * The ticks of a value axis that holds every value and zero: round numbers,
 * about `wanted` of them, the first at or below the smallest and the last at
 * or above the largest.
 */
export function axisTicks(values: readonly number[], wanted = 5): number[] {
    let low = Math.min(0, ...values);
    let high = Math.max(0, ...values);
    if (low === high) high = low + 1;
    const step = niceStep((high - low) / Math.max(1, wanted));
    low = Math.floor(low / step) * step;
    high = Math.ceil(high / step) * step;
    const ticks: number[] = [];
    // Counted rather than added up, so 0.1 steps do not drift to 0.30000000004.
    const count = Math.round((high - low) / step);
    for (let at = 0; at <= count; at += 1) ticks.push(Number((low + at * step).toPrecision(12)));
    return ticks;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface ChartRect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

export interface ChartText {
    readonly x: number;
    readonly y: number;
    readonly text: string;
    readonly anchor: "start" | "middle" | "end";
    /** Whether the text's middle, rather than its baseline, is at `y`. */
    readonly middle?: boolean;
}

export interface ChartMark {
    /** Which series it belongs to - or, in a pie, which category. */
    readonly series: number;
    readonly category: number;
    readonly value: number;
}

export interface BarMark extends ChartMark, ChartRect {}

export interface SliceMark extends ChartMark {
    /** The slice's outline, as an SVG path. */
    readonly path: string;
    readonly share: number;
    readonly label: { readonly x: number; readonly y: number };
}

export interface LineMark {
    readonly series: number;
    readonly points: readonly { readonly x: number; readonly y: number; readonly value: number }[];
    /** For an area: the outline down to the zero line, as an SVG path. */
    readonly area: string;
}

export interface LegendItem {
    readonly x: number;
    readonly y: number;
    readonly label: string;
    readonly color: number;
}

export interface ChartLayout {
    readonly plot: ChartRect;
    /** The grid lines across the value axis, with their numbers. */
    readonly grid: readonly {
        readonly from: { x: number; y: number };
        readonly to: { x: number; y: number };
        readonly label: ChartText;
    }[];
    /** Where the zero line runs, when the chart has one. */
    readonly zero: {
        readonly from: { x: number; y: number };
        readonly to: { x: number; y: number };
    } | null;
    readonly categoryLabels: readonly ChartText[];
    readonly bars: readonly BarMark[];
    readonly lines: readonly LineMark[];
    readonly slices: readonly SliceMark[];
    readonly valueLabels: readonly ChartText[];
    readonly legend: readonly LegendItem[];
    /** The size of a legend's colour swatch. */
    readonly swatch: number;
}

/** About how wide `text` is in a face of size `font` - for room, not for
 *  placing letters. */
function widthOf(text: string, font: number): number {
    return text.length * font * 0.55;
}

/** A value as an axis or a label writes it: no more decimals than it has, up
 *  to two. */
export function formatValue(value: number, locale?: string): string {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/**
 * Where everything in a chart goes, in a box `width` by `height` with words of
 * size `font` - all in the same units.
 */
export function chartLayout(
    chart: SlideChart,
    width: number,
    height: number,
    font: number,
    format: (value: number) => string = (value) => formatValue(value)
): ChartLayout {
    const pad = font * 0.6;
    const legendShown = showsLegend(chart);
    const legendNames =
        chart.kind === "pie" ? chart.categories : chart.series.map((one) => one.name);
    const swatch = font * 0.7;
    const legendRow = legendShown ? font * 1.8 : 0;
    const legend: LegendItem[] = [];
    if (legendShown) {
        const sizes = legendNames.map((label) => swatch + font * 0.4 + widthOf(label, font));
        const gap = font * 1.2;
        const total = sizes.reduce((sum, one) => sum + one, 0) + gap * (sizes.length - 1);
        let x = Math.max(pad, (width - total) / 2);
        const y = height - pad - legendRow / 2;
        legendNames.forEach((label, at) => {
            legend.push({ x, y, label, color: at });
            x += (sizes[at] ?? 0) + gap;
        });
    }
    const empty: Omit<ChartLayout, "plot" | "legend" | "swatch"> = {
        grid: [],
        zero: null,
        categoryLabels: [],
        bars: [],
        lines: [],
        slices: [],
        valueLabels: []
    };

    const inner: ChartRect = {
        x: pad,
        y: pad,
        w: Math.max(1, width - 2 * pad),
        h: Math.max(1, height - 2 * pad - legendRow)
    };

    if (chart.kind === "pie") {
        const values = (chart.series[0]?.values ?? []).map((one) => Math.max(0, one));
        const total = values.reduce((sum, one) => sum + one, 0);
        const radius = Math.max(1, Math.min(inner.w, inner.h) / 2);
        const cx = inner.x + inner.w / 2;
        const cy = inner.y + inner.h / 2;
        const slices: SliceMark[] = [];
        const valueLabels: ChartText[] = [];
        let angle = -Math.PI / 2;
        values.forEach((value, at) => {
            if (total <= 0 || value <= 0) return;
            const share = value / total;
            const sweep = share * Math.PI * 2;
            const end = angle + sweep;
            const point = (a: number) => ({
                x: cx + radius * Math.cos(a),
                y: cy + radius * Math.sin(a)
            });
            const from = point(angle);
            const to = point(end);
            // A slice that is the whole pie is a circle: an arc from a point
            // back to itself draws nothing.
            const path =
                share >= 0.9999
                    ? `M ${cx - radius} ${cy} A ${radius} ${radius} 0 1 1 ${cx + radius} ${cy} A ${radius} ${radius} 0 1 1 ${cx - radius} ${cy} Z`
                    : `M ${cx} ${cy} L ${from.x} ${from.y} A ${radius} ${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${to.x} ${to.y} Z`;
            const middle = angle + sweep / 2;
            const label = {
                x: cx + radius * 0.62 * Math.cos(middle),
                y: cy + radius * 0.62 * Math.sin(middle)
            };
            slices.push({ series: at, category: at, value, path, share, label });
            if (chart.labels) {
                valueLabels.push({
                    ...label,
                    text: `${Math.round(share * 100)}%`,
                    anchor: "middle",
                    middle: true
                });
            }
            angle = end;
        });
        return { ...empty, plot: inner, slices, valueLabels, legend, swatch };
    }

    const all = chart.series.flatMap((one) => one.values);
    const ticks = axisTicks(all);
    const low = ticks[0] ?? 0;
    const high = ticks[ticks.length - 1] ?? 1;
    const span = high - low || 1;
    const tickWidth = Math.max(...ticks.map((one) => widthOf(format(one), font)));
    const count = chart.categories.length;

    if (chart.kind === "bar") {
        // Categories down the side, values along the bottom - the first
        // category at the top, as it is read.
        const labelWidth = Math.min(
            inner.w * 0.35,
            Math.max(...chart.categories.map((one) => widthOf(one, font))) + pad
        );
        const plot: ChartRect = {
            x: inner.x + labelWidth,
            y: inner.y,
            w: Math.max(1, inner.w - labelWidth - tickWidth / 2),
            h: Math.max(1, inner.h - font * 1.6)
        };
        const xOf = (value: number) => plot.x + ((value - low) / span) * plot.w;
        const grid = ticks.map((tick) => ({
            from: { x: xOf(tick), y: plot.y },
            to: { x: xOf(tick), y: plot.y + plot.h },
            label: {
                x: xOf(tick),
                y: plot.y + plot.h + font * 1.2,
                text: format(tick),
                anchor: "middle" as const
            }
        }));
        const band = plot.h / count;
        const group = band * 0.7;
        const each = group / chart.series.length;
        const gap = Math.min(2, each * 0.2);
        const bars: BarMark[] = [];
        const valueLabels: ChartText[] = [];
        chart.series.forEach((one, s) => {
            one.values.forEach((value, c) => {
                const y = plot.y + band * c + (band - group) / 2 + each * s + gap / 2;
                const from = xOf(Math.max(low, Math.min(0, high)));
                const to = xOf(value);
                bars.push({
                    series: s,
                    category: c,
                    value,
                    x: Math.min(from, to),
                    y,
                    w: Math.abs(to - from),
                    h: Math.max(0.5, each - gap)
                });
                if (chart.labels) {
                    valueLabels.push({
                        x: to + (value < 0 ? -font * 0.3 : font * 0.3),
                        y: y + (each - gap) / 2,
                        text: format(value),
                        anchor: value < 0 ? "end" : "start",
                        middle: true
                    });
                }
            });
        });
        const categoryLabels = chart.categories.map((label, c) => ({
            x: plot.x - font * 0.4,
            y: plot.y + band * c + band / 2,
            text: label,
            anchor: "end" as const,
            middle: true
        }));
        const zeroX = xOf(0);
        return {
            plot,
            grid,
            zero:
                low < 0 && high > 0
                    ? { from: { x: zeroX, y: plot.y }, to: { x: zeroX, y: plot.y + plot.h } }
                    : null,
            categoryLabels,
            bars,
            lines: [],
            slices: [],
            valueLabels,
            legend,
            swatch
        };
    }

    // Column, line and area: categories along the bottom, values up the side.
    const plot: ChartRect = {
        x: inner.x + tickWidth + font * 0.5,
        y: inner.y + font * 0.5,
        w: Math.max(1, inner.w - tickWidth - font * 0.5),
        h: Math.max(1, inner.h - font * 1.8 - font * 0.5)
    };
    const yOf = (value: number) => plot.y + plot.h - ((value - low) / span) * plot.h;
    const grid = ticks.map((tick) => ({
        from: { x: plot.x, y: yOf(tick) },
        to: { x: plot.x + plot.w, y: yOf(tick) },
        label: {
            x: plot.x - font * 0.4,
            y: yOf(tick),
            text: format(tick),
            anchor: "end" as const,
            middle: true
        }
    }));
    const band = plot.w / count;
    const categoryLabels = chart.categories.map((label, c) => ({
        x: plot.x + band * c + band / 2,
        y: plot.y + plot.h + font * 1.3,
        text: label,
        anchor: "middle" as const
    }));
    const zeroY = yOf(0);
    const base = yOf(Math.max(low, Math.min(0, high)));
    const zero =
        low < 0 && high > 0
            ? { from: { x: plot.x, y: zeroY }, to: { x: plot.x + plot.w, y: zeroY } }
            : null;

    if (chart.kind === "column") {
        const group = band * 0.7;
        const each = group / chart.series.length;
        const gap = Math.min(2, each * 0.2);
        const bars: BarMark[] = [];
        const valueLabels: ChartText[] = [];
        chart.series.forEach((one, s) => {
            one.values.forEach((value, c) => {
                const x = plot.x + band * c + (band - group) / 2 + each * s + gap / 2;
                const top = yOf(value);
                bars.push({
                    series: s,
                    category: c,
                    value,
                    x,
                    y: Math.min(base, top),
                    w: Math.max(0.5, each - gap),
                    h: Math.abs(top - base)
                });
                if (chart.labels) {
                    valueLabels.push({
                        x: x + (each - gap) / 2,
                        y: value < 0 ? top + font * 1.1 : top - font * 0.35,
                        text: format(value),
                        anchor: "middle"
                    });
                }
            });
        });
        return {
            plot,
            grid,
            zero,
            categoryLabels,
            bars,
            lines: [],
            slices: [],
            valueLabels,
            legend,
            swatch
        };
    }

    const lines: LineMark[] = chart.series.map((one, s) => {
        const points = one.values.map((value, c) => ({
            x: plot.x + band * c + band / 2,
            y: yOf(value),
            value
        }));
        const first = points[0];
        const last = points[points.length - 1];
        const area =
            first && last
                ? `M ${first.x} ${base} ${points.map((point) => `L ${point.x} ${point.y}`).join(" ")} L ${last.x} ${base} Z`
                : "";
        return { series: s, points, area };
    });
    const valueLabels: ChartText[] = chart.labels
        ? lines.flatMap((line) =>
              line.points.map((point) => ({
                  x: point.x,
                  y: point.y - font * 0.6,
                  text: format(point.value),
                  anchor: "middle" as const
              }))
          )
        : [];
    return {
        plot,
        grid,
        zero,
        categoryLabels,
        bars: [],
        lines,
        slices: [],
        valueLabels,
        legend,
        swatch
    };
}

/** A chart's words, for the excerpt and for copied text: its categories and
 *  series names. */
export function chartText(chart: SlideChart): string {
    return [chart.categories.join(", "), chart.series.map((one) => one.name).join(", ")]
        .filter((line) => line.replace(/[,\s]/g, ""))
        .join("\n");
}

/**
 * A number as somebody typed it into a data cell, or null when it is not one.
 * A lone comma is a decimal point, because half the people typing into this
 * write one-and-a-half as "1,5"; commas alongside a point ("1,234.5") or
 * several of them ("1,234,567") group thousands and are dropped.
 */
export function parseValue(typed: string): number | null {
    const trimmed = typed.trim().replace(/\s/g, "");
    if (trimmed === "") return 0;
    const commas = (trimmed.match(/,/g) ?? []).length;
    // With a point, or with several commas, the commas group thousands; one
    // comma alone is the decimal point.
    const normalized =
        trimmed.includes(".") || commas > 1 ? trimmed.replace(/,/g, "") : trimmed.replace(",", ".");
    if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(normalized)) return null;
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
}
