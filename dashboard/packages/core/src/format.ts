/**
 * Display helpers shared by server and client so byte counts and durations read
 * identically wherever they appear. Kept dependency-free and pure.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Format a byte count as a human-readable string (base 1024, 1 decimal). */
export function formatBytes(bytes: number | bigint): string {
    let value = typeof bytes === "bigint" ? Number(bytes) : bytes;
    if (!Number.isFinite(value) || value < 0) return "-";
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
    return `${rounded} ${UNITS[unit]}`;
}
