"use client";

/**
 * The two things the grid cannot do on its own.
 *
 * Univer's open edition ships the grid, the formulas and the formatting, and
 * deliberately does not ship these - they are what its makers sell. The engine
 * behind them is ported from GenOffice (Apache-2.0, see NOTICE) and lives in
 * `@polaris/core/sheets`, pure and tested; this is the screen that points it at
 * a range.
 *
 * **Both write through the shared document rather than through the grid.** The
 * cells in Yjs are what two people typing at once agree about, and what a reload
 * reads - so a sort that went through the engine's own API would be a change one
 * person could see and the other could not. Written the way a keystroke is
 * written, the fill and the sort are ordinary edits that everybody gets.
 *
 * One transaction each, so an undo takes back the whole sort rather than one
 * cell of it.
 */

import * as Y from "yjs";
import { useState } from "react";
import * as engine from "@polaris/core/sheets";
import { ArrowDownUp, Wand2 } from "lucide-react";
import { sheetCellKey, type SheetCell } from "@/lib/office/sheet";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Switch,
    useToast
} from "@polaris/ui";

/** What a cell holds, as a plain value. The engine speaks scalars; the grid
 *  stores an object with a `v` in it. */
function scalarOf(cell: SheetCell | undefined): string | number | boolean | null {
    const held = cell?.v;
    if (held === undefined || held === null) return null;
    if (typeof held === "number" || typeof held === "boolean" || typeof held === "string") {
        return held;
    }
    return String(held);
}

export function SheetTools({
    doc,
    cells,
    sheetId
}: {
    doc: Y.Doc;
    cells: Y.Map<SheetCell>;
    /** Which sheet the tools act on. The first one, which is the one anybody
     *  has when they reach for these. */
    sheetId: string;
}) {
    const toast = useToast();
    const [open, setOpen] = useState<"sort" | "fill" | null>(null);

    return (
        <>
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
                <Button size="sm" variant="ghost" onClick={() => setOpen("sort")}>
                    <ArrowDownUp className="size-4 shrink-0" aria-hidden />
                    Sort a range
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen("fill")}>
                    <Wand2 className="size-4 shrink-0" aria-hidden />
                    Fill from examples
                </Button>
            </div>

            {open === "sort" ? (
                <SortDialog
                    doc={doc}
                    cells={cells}
                    sheetId={sheetId}
                    onClose={() => setOpen(null)}
                    onDone={(moved) =>
                        toast.show({
                            title: moved ? `${moved} cells moved.` : "Nothing needed moving."
                        })
                    }
                />
            ) : null}

            {open === "fill" ? (
                <FillDialog
                    doc={doc}
                    cells={cells}
                    sheetId={sheetId}
                    onClose={() => setOpen(null)}
                    onDone={(filled, said) => toast.show({ title: said || `${filled} cells filled.` })}
                />
            ) : null}
        </>
    );
}

/** Sorting a range, which is not sorting a sheet: what is outside the range does
 *  not move, and that is the whole difference. */
function SortDialog({
    doc,
    cells,
    sheetId,
    onClose,
    onDone
}: {
    doc: Y.Doc;
    cells: Y.Map<SheetCell>;
    sheetId: string;
    onClose: () => void;
    onDone: (moved: number) => void;
}) {
    const [range, setRange] = useState("A1:C10");
    const [column, setColumn] = useState("A");
    const [ascending, setAscending] = useState(true);
    const [hasHeader, setHasHeader] = useState(true);
    const [problem, setProblem] = useState("");

    const run = (): void => {
        setProblem("");
        try {
            const changes = engine.computeSortChanges(
                { range: range.trim().toUpperCase(), byColumn: column.trim().toUpperCase(), ascending, hasHeader },
                (address) => {
                    const at = engine.parseAddress(address);
                    return {
                        value: scalarOf(cells.get(sheetCellKey(sheetId, at.row, at.column)))
                    } as never;
                }
            );
            // One transaction, so an undo takes back the sort rather than a cell
            // of it - and so the other side sees it arrive as one change.
            doc.transact(() => {
                for (const change of changes) {
                    const at = engine.parseAddress(change.address);
                    const key = sheetCellKey(sheetId, at.row, at.column);
                    if (change.after === null || change.after === "") cells.delete(key);
                    else cells.set(key, { ...cells.get(key), v: change.after } as SheetCell);
                }
            });
            onDone(changes.length);
            onClose();
        } catch (caught) {
            // The engine refuses with a sentence somebody can act on - a column
            // outside the range, a range with one row in it - so it is shown
            // rather than swallowed.
            setProblem(caught instanceof Error ? caught.message : "That range could not be sorted.");
        }
    };

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Sort a range</DialogTitle>
                    <DialogDescription>
                        Only what is inside the range moves. Blanks go last, and numbers sort before
                        text - the order every spreadsheet uses.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">Range</span>
                        <Input
                            value={range}
                            placeholder="A1:C10"
                            onChange={(event) => setRange(event.target.value)}
                        />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">
                            Sort by column
                        </span>
                        <Input
                            value={column}
                            placeholder="A"
                            className="w-24"
                            onChange={(event) => setColumn(event.target.value)}
                        />
                    </label>
                    <label className="flex items-center gap-2 text-[13px]">
                        <Switch
                            checked={hasHeader}
                            onChange={setHasHeader}
                            aria-label="The first row is a header"
                        />
                        The first row is a header
                    </label>
                    <label className="flex items-center gap-2 text-[13px]">
                        <Switch
                            checked={ascending}
                            onChange={setAscending}
                            aria-label="Smallest first"
                        />
                        Smallest first
                    </label>
                    {problem ? <p className="text-[12px] text-danger">{problem}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="secondary" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button onClick={run}>Sort</Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Flash fill: work out what somebody is doing from an example of them doing it.
 *
 * They have typed one answer beside their data; this reads the pattern out of it
 * and finishes the column. Refuses rather than guessing when the example cannot
 * be explained by joining the source columns together - a wrong guess here fills
 * a hundred rows with nonsense, and a refusal costs one sentence.
 */
function FillDialog({
    doc,
    cells,
    sheetId,
    onClose,
    onDone
}: {
    doc: Y.Doc;
    cells: Y.Map<SheetCell>;
    sheetId: string;
    onClose: () => void;
    onDone: (filled: number, said: string) => void;
}) {
    const [source, setSource] = useState("A2:B10");
    const [into, setInto] = useState("C");
    const [problem, setProblem] = useState("");

    const run = (): void => {
        setProblem("");
        try {
            const bounds = engine.parseRange(source.trim().toUpperCase());
            const target = engine.columnIndex(into.trim().toUpperCase());
            const read = (row: number, column: number): string => {
                const held = scalarOf(cells.get(sheetCellKey(sheetId, row, column)));
                return held === null ? "" : String(held);
            };

            const rows: { row: number; source: string[]; output: string }[] = [];
            for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
                const fields: string[] = [];
                for (let column = bounds.startColumn; column <= bounds.endColumn; column += 1) {
                    fields.push(read(row, column));
                }
                rows.push({ row, source: fields, output: read(row, target) });
            }

            // The rows somebody has already answered are the examples; the rest
            // are what gets filled. One example is enough, which is the whole
            // appeal of the feature.
            const examples = rows.filter((one) => one.output.trim());
            if (examples.length === 0) {
                setProblem("Type the answer you want on the first row, and this fills the rest.");
                return;
            }
            const template = engine.inferFlashFillTemplate(examples);
            if (!template) {
                setProblem(
                    "That cannot be worked out from the columns beside it. Flash fill joins them together - it does not cut them up."
                );
                return;
            }

            let filled = 0;
            doc.transact(() => {
                for (const one of rows) {
                    if (one.output.trim()) continue;
                    const value = engine.applyFlashFillTemplate(template, one.source);
                    if (!value) continue;
                    cells.set(sheetCellKey(sheetId, one.row, target), { v: value } as SheetCell);
                    filled += 1;
                }
            });
            onDone(filled, filled === 0 ? "Every row was already filled in." : "");
            onClose();
        } catch {
            setProblem("That range could not be read. It looks like A2:B10.");
        }
    };

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Fill from examples</DialogTitle>
                    <DialogDescription>
                        Type the answer you want on one row, and the rest of the column is filled
                        the same way.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">
                            The columns to read
                        </span>
                        <Input
                            value={source}
                            placeholder="A2:B10"
                            onChange={(event) => setSource(event.target.value)}
                        />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">
                            The column to fill
                        </span>
                        <Input
                            value={into}
                            placeholder="C"
                            className="w-24"
                            onChange={(event) => setInto(event.target.value)}
                        />
                    </label>
                    {problem ? <p className="text-[12px] text-danger">{problem}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="secondary" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button onClick={run}>Fill</Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
