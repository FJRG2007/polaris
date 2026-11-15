/**
 * How the analytics screens, and the printed report, write a number. Client-safe.
 */

/** Thousands separators without a locale: the browser's separator disagrees with the
 *  server on the first render, and it is not the reader's chosen format either. */
export function grouped(value: number): string {
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function percent(value: number | null): string {
    return value === null ? "-" : `${Math.round(value * 100)}%`;
}

/** A duration as somebody would say it: "0s", "48s", "3m 12s", "1h 04m". */
export function duration(seconds: number | null): string {
    if (seconds === null) return "-";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Hangs each note on the chart point whose bucket holds it, as that point's
 * hover note: the nearest point at or before the note, so a note never reads
 * against the bucket after its own.
 */
export function notesByPoint(
    points: readonly { t: number }[],
    notes: readonly { at: number; text: string }[]
): Map<number, string> {
    const byPoint = new Map<number, string[]>();
    for (const note of notes) {
        let index = -1;
        for (let i = 0; i < points.length && points[i]!.t <= note.at; i += 1) index = i;
        if (index < 0) continue;
        const list = byPoint.get(index) ?? [];
        list.push(note.text);
        byPoint.set(index, list);
    }
    return new Map([...byPoint].map(([index, texts]) => [index, texts.join(" / ")]));
}
