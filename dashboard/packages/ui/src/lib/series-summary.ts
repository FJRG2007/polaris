/**
 * The numbers a time-series chart puts in its header.
 *
 * Kept apart from the chart because deciding what to show is the only part with
 * any judgement in it: a single current reading says nothing about whether it is
 * normal, so the window's mean and peak sit beside it - but whichever of the two
 * the headline already is must not be printed twice.
 */

/** How the headline number summarizes the window. */
export type SeriesSummary = "last" | "sum" | "avg" | "max";

export interface SeriesStats {
    /** The headline, per the chosen summary. Null when the window has no data. */
    headline: number | null;
    /** The secondary readings, in render order. Empty when there is no data. */
    stats: Array<{ label: string; value: number }>;
}

/**
 * Summarize the readings actually present in the window (nulls are gaps in
 * collection, not zeroes - averaging them in would drag every mean toward zero
 * whenever a device was briefly unreachable).
 */
export function summarizeSeries(values: readonly number[], summary: SeriesSummary = "last"): SeriesStats {
    if (values.length === 0) return { headline: null, stats: [] };

    const total = values.reduce((sum, value) => sum + value, 0);
    const average = total / values.length;
    const peak = values.reduce((high, value) => Math.max(high, value), values[0]!);
    const headline =
        summary === "sum"
            ? total
            : summary === "avg"
              ? average
              : summary === "max"
                ? peak
                : values[values.length - 1]!;

    const stats: Array<{ label: string; value: number }> = [];
    if (summary !== "avg") stats.push({ label: "avg", value: average });
    if (summary !== "max") stats.push({ label: "peak", value: peak });
    return { headline, stats };
}
