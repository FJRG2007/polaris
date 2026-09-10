/**
 * What a metric on a Watch card breaks down into, and the arithmetic every
 * breakdown shares.
 *
 * A chart answers "how much"; the question that always follows it is "of what".
 * 88 GB of storage and almost nothing installed is the same complaint every time,
 * and it cannot be answered by a line - only by a list, ranked, with each row's
 * share of the whole.
 *
 * Three rules hold for all four metrics, and they are the reason this is a module
 * rather than four sorts:
 *
 *   - Nothing that is using none of it appears. A ranking of things at zero is a
 *     longer screen that answers nothing.
 *   - A whole is never smaller than its parts. Every total here is measured
 *     separately from the rows under it - a machine's disk against the volumes on
 *     it, a machine's traffic against the services that made it - and two readings
 *     taken moments apart can disagree. When they do, the parts win and the shares
 *     are of what could be attributed, which is the honest denominator.
 *   - What is left over is a row too, and it says so. The gap between a disk and
 *     the things on it a screen can name IS the answer for most people; leaving it
 *     out makes the list look complete when it is the smaller half.
 *
 * Pure on purpose. Ranking, shares, the leftover and "this cannot be answered"
 * are the parts worth pinning down in a test, and none of them needs a database,
 * a daemon, or a machine that answers.
 */

/** The cards that open onto a breakdown, by the key `CONSUMPTION_METRICS` gives
 *  each one ("net" is bandwidth out; bandwidth in has none). Declared as
 *  a tuple so the schema that accepts one and the panel that draws one are the
 *  same list rather than two lists that agree today. */
export const BREAKDOWN_METRICS = ["cpu", "mem", "disk", "net"] as const;

export type BreakdownMetric = (typeof BREAKDOWN_METRICS)[number];

/** What a row is, which is what decides its icon and whether it says so. */
export type BreakdownKind = "container" | "volume" | "store" | "rest";

/** One thing using the metric, and what a reader can do about it. */
export interface BreakdownRow {
    readonly key: string;
    readonly label: string;
    readonly kind: BreakdownKind;
    /** The one line worth knowing beside the name: what it belongs to, where it
     *  is mounted, what it is for. Null where there is nothing to add. */
    readonly detail: string | null;
    /** The measured amount, in the metric's own units. */
    readonly value: number;
    /** 0 to 1 of the whole, or null when there is no whole to be part of. */
    readonly share: number | null;
    /** Where this thing lives, when it has a page of its own. */
    readonly href: string | null;
}

/** A row before it knows how big a part of the whole it is. */
export type BreakdownPart = Omit<BreakdownRow, "share">;

/** One metric, taken apart. */
export interface Breakdown {
    readonly rows: readonly BreakdownRow[];
    /** The whole the shares are of, in the same units as a row. */
    readonly total: number | null;
    /** What was measured and what was not, in one sentence. Always said: every
     *  one of these is a partial view of its metric, and a list that does not
     *  admit its edges reads as the whole answer. */
    readonly note: string;
    /** Set when there is nothing to rank, and says why in the reader's terms. */
    readonly unavailable: string | null;
    /** When the figures were read, for the ones read live rather than from the
     *  stored history. Null where the question is "over this window" and an
     *  instant would mean nothing. */
    readonly at: number | null;
}

/**
 * Below this share of the whole, the leftover is not worth a row.
 *
 * Two readings taken a moment apart never add up exactly, and a "everything else"
 * row holding a rounding error is worse than no row: it invites somebody to go
 * looking for something that is not there.
 */
const REMAINDER_FLOOR = 0.01;

/** Heaviest first, each row against the whole. */
export function ranked(parts: readonly BreakdownPart[], total: number | null): BreakdownRow[] {
    return parts
        .filter((part) => Number.isFinite(part.value) && part.value > 0)
        .sort((left, right) => right.value - left.value)
        .map((part) => ({
            ...part,
            // Capped at the whole: a part measured a moment after the total it is
            // divided by can come out at 101%, which reads as a broken number.
            share: total !== null && total > 0 ? Math.min(1, part.value / total) : null
        }));
}

/**
 * The whole the shares are of.
 *
 * `measured` is the metric's own total where something measured it - the disk the
 * machine reports, the memory it has, the traffic it counted. Where nothing did,
 * or where it comes back smaller than the things inside it, the parts are the
 * whole and every share is a share of what could be attributed.
 */
export function wholeOf(measured: number | null, parts: readonly BreakdownPart[]): number | null {
    const sum = parts.reduce((total, part) => total + Math.max(0, part.value), 0);
    if (measured === null || !Number.isFinite(measured) || measured <= 0)
        return sum > 0 ? sum : null;
    return measured >= sum ? measured : sum;
}

/**
 * What is left of the whole once everything that could be named is taken out.
 *
 * Null when there is no whole, when the parts fill it, or when the gap is small
 * enough to be the disagreement between two readings rather than a thing.
 */
export function remainder(
    total: number | null,
    parts: readonly BreakdownPart[],
    row: { key: string; label: string; detail: string }
): BreakdownPart | null {
    if (total === null || !Number.isFinite(total) || total <= 0) return null;
    const left = total - parts.reduce((sum, part) => sum + Math.max(0, part.value), 0);
    if (left <= total * REMAINDER_FLOOR) return null;
    return { ...row, kind: "rest", value: left, href: null };
}

/**
 * A window's worth of a counter as bytes per second.
 *
 * Null rather than zero wherever the counter could not say how far it moved: one
 * reading is a position, not a distance, and a service that was only sampled once
 * inside the window has to be left out rather than charted at nothing.
 */
export function ratePerSecond(moved: bigint | null, spanMs: number): number | null {
    if (moved === null || spanMs <= 0) return null;
    return Number(moved) / (spanMs / 1000);
}

/** A breakdown that has nothing to show, and says why. */
export function nothingToShow(reason: string): Breakdown {
    return { rows: [], total: null, note: "", unavailable: reason, at: null };
}
