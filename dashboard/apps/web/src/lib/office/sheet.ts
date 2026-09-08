/**
 * Two people typing in the same spreadsheet.
 *
 * The spreadsheet engine is Univer, which is open source and has no
 * collaboration in it - that is the half its makers sell. So this is the bridge:
 * the workbook on one side, a shared document on the other, and a rule for
 * moving cells between them.
 *
 * **A cell at a time, not a workbook at a time.** Each cell lives under its own
 * key, so two people typing in two cells is two independent changes and neither
 * overwrites the other. Sending the workbook would make every keystroke a change
 * to everything, and whoever saved second would erase whoever saved first - which
 * is the difference between a shared spreadsheet and a spreadsheet two people are
 * fighting over.
 *
 * Pure, and away from the engine, so the part that is easy to get wrong can be
 * tested without a canvas: what changed, what to write, and what a cell coming
 * back from somebody else should do to the one already there.
 */

/** What a cell holds, as the engine stores it. `v` is the value, `f` a formula,
 *  `s` the style, and there are a few more nobody here has to know about - the
 *  whole object travels. */
export interface SheetCell {
    readonly [key: string]: unknown;
}

/** Where a cell is. One function, because the editor and every exporter have to
 *  agree and a mismatched separator loses a column silently. */
export function sheetCellKey(sheetId: string, row: number, column: number): string {
    return `${sheetId}:${row}:${column}`;
}

/** Read one back. Null for anything that is not one, which is a row somebody
 *  hand-edited or a document from a build that spelt it differently. */
export function readSheetCellKey(
    key: string
): { sheetId: string; row: number; column: number } | null {
    const at = key.lastIndexOf(":");
    if (at < 0) return null;
    const before = key.lastIndexOf(":", at - 1);
    if (before < 0) return null;
    const row = Number(key.slice(before + 1, at));
    const column = Number(key.slice(at + 1));
    if (!Number.isInteger(row) || !Number.isInteger(column)) return null;
    return { sheetId: key.slice(0, before), row, column };
}

/** As much of a workbook as this needs to know about. The engine's own type has
 *  forty fields; these are the two the cells hang off. */
export interface WorkbookLike {
    readonly sheets?: Record<string, { cellData?: Record<string, Record<string, SheetCell>> } | undefined>;
}

/**
 * Every cell in a workbook, flattened.
 *
 * The engine stores them as a sparse two-level object keyed by row then column,
 * which is the right shape for drawing a grid and the wrong one for comparing
 * two of them.
 */
export function cellsOf(workbook: WorkbookLike): Map<string, SheetCell> {
    const cells = new Map<string, SheetCell>();
    for (const [sheetId, sheet] of Object.entries(workbook.sheets ?? {})) {
        for (const [row, columns] of Object.entries(sheet?.cellData ?? {})) {
            for (const [column, cell] of Object.entries(columns ?? {})) {
                if (!cell) continue;
                cells.set(sheetCellKey(sheetId, Number(row), Number(column)), cell);
            }
        }
    }
    return cells;
}

/** Whether two cells say the same thing. Compared by their content rather than
 *  by identity: the engine rebuilds these objects constantly, and treating a
 *  fresh object as a change would be a write on every render. */
export function sameCell(left: SheetCell | undefined, right: SheetCell | undefined): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return JSON.stringify(left) === JSON.stringify(right);
}

/** What one cell became. `null` is a cell that was emptied, which has to travel
 *  as deliberately as one that was filled: dropping it is how a number somebody
 *  cleared comes back on everybody else's screen. */
export interface CellChange {
    readonly key: string;
    readonly cell: SheetCell | null;
}

/**
 * What this workbook has that the shared document does not.
 *
 * Both directions of difference, because both are changes: a cell that appeared
 * or was edited, and a cell that is gone. Anything unchanged is left out - the
 * engine reports a command for a selection or a scroll, and writing the whole
 * sheet on those is a write per pointer move.
 */
export function changedCells(
    mine: ReadonlyMap<string, SheetCell>,
    theirs: ReadonlyMap<string, SheetCell>
): CellChange[] {
    const changes: CellChange[] = [];
    for (const [key, cell] of mine) {
        if (!sameCell(cell, theirs.get(key))) changes.push({ key, cell });
    }
    for (const key of theirs.keys()) {
        if (!mine.has(key)) changes.push({ key, cell: null });
    }
    return changes;
}

/**
 * What to put into the workbook when somebody else's cells arrive.
 *
 * The same difference the other way round, and it is deliberately not "apply
 * everything they have": writing a cell the workbook already agrees about makes
 * the engine emit a command, which this file would then read as a local change
 * and send straight back out. Two screens doing that to each other is a loop
 * that never settles.
 */
export function incomingCells(
    mine: ReadonlyMap<string, SheetCell>,
    theirs: ReadonlyMap<string, SheetCell>
): CellChange[] {
    const changes: CellChange[] = [];
    for (const [key, cell] of theirs) {
        if (!sameCell(cell, mine.get(key))) changes.push({ key, cell });
    }
    for (const key of mine.keys()) {
        if (!theirs.has(key)) changes.push({ key, cell: null });
    }
    return changes;
}
