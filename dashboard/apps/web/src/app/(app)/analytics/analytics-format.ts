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
