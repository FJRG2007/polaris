/**
 * Printing: a padded table for people, JSON for scripts (`--json`).
 */

import type { Io } from "./context.js";

/** Columns padded to their widest cell, two spaces apart. Cells are single-line:
 *  anything after a line break is dropped, so a commit message cannot break the
 *  table. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
    const clean = (cell: string) => cell.split(/\r?\n/)[0] ?? "";
    const all = [headers, ...rows].map((row) => row.map(clean));
    const widths = headers.map((_, column) =>
        Math.max(...all.map((row) => (row[column] ?? "").length))
    );
    return `${all
        .map((row) =>
            row
                .map((cell, column) =>
                    column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)
                )
                .join("  ")
                .trimEnd()
        )
        .join("\n")}\n`;
}

/** Pretty JSON with a trailing newline, for `--json`. */
export function printJson(io: Io, value: unknown): void {
    io.out(`${JSON.stringify(value, null, 2)}\n`);
}

/** A block of text, ending in exactly one newline. */
export function line(io: Io, text: string): void {
    io.out(text.endsWith("\n") ? text : `${text}\n`);
}
