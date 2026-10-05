/**
 * Box-drawn text table, in the exact layout the `table` package printed by
 * default - the per-run token table is read back out of job logs by scripts
 * that expect it - for the one use this runtime has: a few rows of short cells.
 *
 *   ╔═══════╤════════════╗
 *   ║ Input │ Cache Read ║
 *   ╟───────┼────────────╢
 *   ║ 1,234 │ 0          ║
 *   ╚═══════╧════════════╝
 *
 * Cells are left-aligned and padded by one space; a cell with a line break
 * spans several lines. Width counts East Asian wide characters and emoji as two
 * columns, as a terminal draws them.
 */

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Wide (two-column) ranges: CJK, Hangul, fullwidth forms, and emoji. */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u;

/** Columns a string takes in a terminal. */
export function displayWidth(text: string): number {
    let width = 0;
    for (const { segment } of segmenter.segment(text)) {
        if (/^\p{Mark}+$/u.test(segment) || segment === ZERO_WIDTH_SPACE) continue;
        width += WIDE.test(segment) ? 2 : 1;
    }
    return width;
}

const pad = (text: string, width: number) =>
    text + " ".repeat(Math.max(0, width - displayWidth(text)));

export function textTable(rows: readonly (readonly string[])[]): string {
    if (rows.length === 0) return "";
    const columns = Math.max(...rows.map((row) => row.length));
    const cells = rows.map((row) =>
        Array.from({ length: columns }, (_, i) => String(row[i] ?? "").split(/\r?\n/))
    );
    const widths = Array.from({ length: columns }, (_, i) =>
        Math.max(...cells.flatMap((row) => row[i]!.map(displayWidth)))
    );
    const rule = (left: string, fill: string, join: string, right: string) =>
        `${left}${widths.map((w) => fill.repeat(w + 2)).join(join)}${right}`;
    const lines = [rule("╔", "═", "╤", "╗")];
    cells.forEach((row, index) => {
        if (index > 0) lines.push(rule("╟", "─", "┼", "╢"));
        const height = Math.max(...row.map((cell) => cell.length));
        for (let line = 0; line < height; line++) {
            lines.push(
                `║ ${row.map((cell, i) => pad(cell[line] ?? "", widths[i]!)).join(" │ ")} ║`
            );
        }
    });
    lines.push(rule("╚", "═", "╧", "╝"));
    return `${lines.join("\n")}\n`;
}
