/**
 * A table on a slide.
 *
 * A grid of words and nothing else: rows of cells, how wide each column is, and
 * whether the first row is a header and the rows are banded - the two switches
 * Google Slides and PowerPoint put first on their table menus. The words' face,
 * size and colour, the header's fill and the borders' colour belong to the box
 * the table sits in, so the format bar that formats a text box formats a table.
 *
 * The whole table lives in its box, so a cell typed into is one change to one
 * box on the wire. It is always written by reading the box as it is now and
 * changing that one cell (`setCell`), so two people typing in two cells only
 * collide when both press at the same moment.
 *
 * Pure, so every insertion, removal and resize can be tested without a canvas.
 */

/** As many rows and columns as a table may have - Google Slides' own limit,
 *  and far past what a slide can show legibly. */
export const TABLE_MAX = 20;

/** The narrowest a column may be dragged, as a share of the table's width. */
export const COLUMN_MIN = 0.04;

export interface SlideTable {
    /** The words of every cell, row by row; every row as long as `cols`. */
    readonly rows: readonly (readonly string[])[];
    /** Each column's share of the table's width, together 1. */
    readonly cols: readonly number[];
    /** The first row is drawn as a header: filled, its words bold. */
    readonly header: boolean;
    /** Every other body row is tinted. */
    readonly banded: boolean;
}

/** Where a cell is. */
export interface CellAt {
    readonly row: number;
    readonly col: number;
}

/** The longest a cell's words may be. */
export const CELL_MAX = 2_000;

function clampCount(value: number): number {
    return Math.min(TABLE_MAX, Math.max(1, Math.round(value)));
}

/** Widths that are all positive and add up to one, `count` of them. */
function evenCols(count: number): number[] {
    return Array.from({ length: count }, () => 1 / count);
}

function normalize(cols: readonly number[]): number[] {
    const kept = cols.map((one) => (Number.isFinite(one) && one > 0 ? one : 0));
    const total = kept.reduce((sum, one) => sum + one, 0);
    if (total <= 0) return evenCols(cols.length);
    // A column with no width gets the narrowest, and everything is scaled
    // back to one again.
    const floored = kept.map((one) => Math.max(COLUMN_MIN, one / total));
    const again = floored.reduce((sum, one) => sum + one, 0);
    return floored.map((one) => one / again);
}

/** A new table, `rows` by `cols`, empty, with a header row. */
export function newTable(rows: number, cols: number): SlideTable {
    const height = clampCount(rows);
    const width = clampCount(cols);
    return {
        rows: Array.from({ length: height }, () => Array.from({ length: width }, () => "")),
        cols: evenCols(width),
        header: true,
        banded: false
    };
}

/**
 * A table as stored, made whole: every row padded or cut to the number of
 * columns, every cell a string of a bounded length, the widths positive and
 * summing to one. Anything that is not a table at all is a one-cell table, so
 * a box an older or a hostile writer left half-made still draws.
 */
export function readTable(raw: unknown): SlideTable {
    const one = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const storedRows = Array.isArray(one.rows) ? one.rows.slice(0, TABLE_MAX) : [];
    const storedCols = Array.isArray(one.cols) ? one.cols.slice(0, TABLE_MAX) : [];
    const widest = storedRows.reduce<number>(
        (most, row) => Math.max(most, Array.isArray(row) ? row.length : 0),
        0
    );
    const width = clampCount(Math.max(storedCols.length, widest, 1));
    const rows = (storedRows.length > 0 ? storedRows : [[]]).map((row) =>
        Array.from({ length: width }, (_, at) => {
            const cell = Array.isArray(row) ? row[at] : undefined;
            return typeof cell === "string" ? cell.slice(0, CELL_MAX) : "";
        })
    );
    const cols =
        storedCols.length === width
            ? normalize(storedCols.map((value) => (typeof value === "number" ? value : 0)))
            : evenCols(width);
    return { rows, cols, header: one.header !== false, banded: one.banded === true };
}

export function rowCount(table: SlideTable): number {
    return table.rows.length;
}

export function colCount(table: SlideTable): number {
    return table.cols.length;
}

/** A cell kept inside the table. */
export function clampCell(table: SlideTable, at: CellAt): CellAt {
    return {
        row: Math.min(rowCount(table) - 1, Math.max(0, at.row)),
        col: Math.min(colCount(table) - 1, Math.max(0, at.col))
    };
}

export function cellText(table: SlideTable, at: CellAt): string {
    return table.rows[at.row]?.[at.col] ?? "";
}

/** The table with one cell's words changed, or the same table when they
 *  already say that. */
export function setCell(table: SlideTable, at: CellAt, text: string): SlideTable {
    const kept = text.slice(0, CELL_MAX);
    if (cellText(table, at) === kept) return table;
    if (at.row < 0 || at.row >= rowCount(table) || at.col < 0 || at.col >= colCount(table)) {
        return table;
    }
    return {
        ...table,
        rows: table.rows.map((row, r) =>
            r === at.row ? row.map((cell, c) => (c === at.col ? kept : cell)) : row
        )
    };
}

/** An empty row put in at `at`, or the same table when it is full. */
export function insertRow(table: SlideTable, at: number): SlideTable {
    if (rowCount(table) >= TABLE_MAX) return table;
    const where = Math.min(rowCount(table), Math.max(0, at));
    const rows = [...table.rows];
    rows.splice(
        where,
        0,
        Array.from({ length: colCount(table) }, () => "")
    );
    return { ...table, rows };
}

/** A row taken out - never the last one: a table with no rows is no table. */
export function removeRow(table: SlideTable, at: number): SlideTable {
    if (rowCount(table) <= 1 || at < 0 || at >= rowCount(table)) return table;
    return { ...table, rows: table.rows.filter((_, r) => r !== at) };
}

/**
 * An empty column put in at `at`, as wide as the column it is put beside, the
 * others narrowed in proportion so the table keeps its width - which is what
 * PowerPoint does, and why a table never grows off the slide by gaining one.
 */
export function insertCol(table: SlideTable, at: number): SlideTable {
    if (colCount(table) >= TABLE_MAX) return table;
    const where = Math.min(colCount(table), Math.max(0, at));
    const beside = table.cols[Math.min(where, colCount(table) - 1)] ?? 1 / colCount(table);
    const cols = [...table.cols];
    cols.splice(where, 0, beside);
    return {
        ...table,
        cols: normalize(cols),
        rows: table.rows.map((row) => {
            const next = [...row];
            next.splice(where, 0, "");
            return next;
        })
    };
}

/** A column taken out, the others widened in proportion - never the last. */
export function removeCol(table: SlideTable, at: number): SlideTable {
    if (colCount(table) <= 1 || at < 0 || at >= colCount(table)) return table;
    return {
        ...table,
        cols: normalize(table.cols.filter((_, c) => c !== at)),
        rows: table.rows.map((row) => row.filter((_, c) => c !== at))
    };
}

/**
 * The border after column `border` (0 is the one between the first two
 * columns) dragged by `by`, a share of the table's width: the columns on
 * either side of it trade width, and neither becomes narrower than
 * `COLUMN_MIN`. The table's own width never changes.
 */
export function resizeCol(table: SlideTable, border: number, by: number): SlideTable {
    const left = table.cols[border];
    const right = table.cols[border + 1];
    if (left === undefined || right === undefined) return table;
    const moved = Math.min(right - COLUMN_MIN, Math.max(COLUMN_MIN - left, by));
    if (Math.abs(moved) < 1e-9) return table;
    return {
        ...table,
        cols: table.cols.map((one, c) =>
            c === border ? left + moved : c === border + 1 ? right - moved : one
        )
    };
}

/** Where each column border sits, as a share of the table's width from its
 *  left edge - one fewer than there are columns. */
export function colBorders(table: SlideTable): number[] {
    const borders: number[] = [];
    let across = 0;
    for (const width of table.cols.slice(0, -1)) {
        across += width;
        borders.push(across);
    }
    return borders;
}

/**
 * The cell Tab moves to from `at`: the next along the row, then the first of
 * the next row; Shift+Tab the other way. Tab in the last cell answers `grow`,
 * because there a new row is added and its first cell is where typing goes -
 * PowerPoint's and Google Slides' behaviour both.
 */
export function nextCell(table: SlideTable, at: CellAt, back: boolean): CellAt | "grow" | null {
    const width = colCount(table);
    const index = at.row * width + at.col + (back ? -1 : 1);
    if (index < 0) return null;
    if (index >= rowCount(table) * width) return "grow";
    return { row: Math.floor(index / width), col: index % width };
}

/** A table's words, as lines - a row to a line, its cells apart by tabs - for
 *  the excerpt, plain copied text and anything else that reads words. */
export function tableText(table: SlideTable): string {
    return table.rows
        .map((row) => row.map((cell) => cell.replace(/\s+/g, " ").trim()).join("\t"))
        .filter((line) => line.trim())
        .join("\n");
}
