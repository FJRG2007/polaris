"use client";

/**
 * Spreadsheet viewer and editor. Every sheet of the workbook is shown as a
 * virtualized grid of cells that can be typed into; the write-back keeps the
 * original file's formatting (see sheet-format). Very large sheets stay
 * read-only, and a legacy .xls/.ods can only be saved as a converted .xlsx copy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { extName } from "@polaris/core";
import { cn } from "@polaris/ui";
import { EditorActions } from "./editor-actions";
import {
    EDITABLE_CELL_LIMIT,
    editKey,
    exportConvertedXlsx,
    exportDelimited,
    exportPatchedXlsx,
    readWorkbook,
    type CellEdit,
    type SheetGrid
} from "./sheet-format";
import { Loading, ViewerError } from "./status";
import type { ViewerTarget } from "./types";

const ROW_HEIGHT = 28;
const COLUMN_WIDTH = 128;
const ROW_HEADER_WIDTH = 56;

/** Spreadsheet column label for a zero-based index (0 -> A, 26 -> AA). */
function columnLabel(index: number): string {
    let label = "";
    for (let value = index; value >= 0; value = Math.floor(value / 26) - 1) {
        label = String.fromCharCode(65 + (value % 26)) + label;
    }
    return label;
}

export function SheetEditor({
    src,
    target,
    readOnly = false,
    onSaved
}: {
    src: string;
    target: ViewerTarget;
    readOnly?: boolean;
    onSaved?: (name: string) => void;
}) {
    const [grids, setGrids] = useState<SheetGrid[] | null>(null);
    const [cells, setCells] = useState(0);
    const [active, setActive] = useState(0);
    const [error, setError] = useState(false);
    const [dirty, setDirty] = useState(false);
    // The pristine bytes (patched on an .xlsx save) and the parsed workbook (used
    // for a converted or delimited export) outlive re-renders untouched.
    const source = useRef<ArrayBuffer | null>(null);
    const workbook = useRef<Awaited<ReturnType<typeof readWorkbook>>["workbook"] | null>(null);
    const edits = useRef(new Map<string, CellEdit>());
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let alive = true;
        setGrids(null);
        setError(false);
        setDirty(false);
        setActive(0);
        edits.current = new Map();
        void (async () => {
            try {
                const response = await fetch(src);
                if (!response.ok) throw new Error("read failed");
                const bytes = await response.arrayBuffer();
                const parsed = await readWorkbook(bytes);
                if (!alive) return;
                source.current = bytes;
                workbook.current = parsed.workbook;
                setCells(parsed.cells);
                setGrids(parsed.grids);
            } catch {
                if (alive) setError(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, [src]);

    const grid = grids?.[active] ?? null;
    const sourceExtension = extName(target.name);
    const editable = !readOnly && cells <= EDITABLE_CELL_LIMIT;
    // A legacy format is never rewritten in place: SheetJS is the only writer for
    // it and would drop everything it does not model, so it converts to .xlsx.
    const exportExtension =
        sourceExtension === "xls" || sourceExtension === "ods" ? "xlsx" : undefined;

    const rowVirtualizer = useVirtualizer({
        count: grid?.rows.length ?? 0,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12
    });

    function changeCell(row: number, column: number, value: string) {
        if (!grid) return;
        setGrids((previous) => {
            if (!previous) return previous;
            const next = previous.slice();
            const rows = grid.rows.slice();
            const values = rows[row]?.slice() ?? [];
            values[column] = value;
            rows[row] = values;
            next[active] = { ...grid, rows };
            return next;
        });
        edits.current.set(editKey(grid.name, row, column), {
            sheet: grid.name,
            row,
            column,
            value
        });
        setDirty(true);
    }

    const exportAs = useCallback(
        async (name: string): Promise<Blob> => {
            const parsed = workbook.current;
            const bytes = source.current;
            if (!parsed || !bytes) throw new Error("workbook not loaded");
            const pending = [...edits.current.values()];
            const extension = extName(name);
            if (extension === "csv" || extension === "tsv") {
                const sheetName = grids?.[active]?.name ?? parsed.SheetNames[0] ?? "";
                return exportDelimited(parsed, pending, sheetName, extension);
            }
            // Only a workbook that arrived as .xlsx can be patched byte-wise.
            if (sourceExtension === "xlsx") return exportPatchedXlsx(bytes, pending);
            return exportConvertedXlsx(parsed, pending);
        },
        [active, grids, sourceExtension]
    );

    /** Overwriting the original clears the pending flag; the edits stay, since a
     *  later save patches the same pristine bytes again. */
    function afterSave(name: string) {
        if (name === target.name) setDirty(false);
        onSaved?.(name);
    }

    const columns = useMemo(
        () => Array.from({ length: grid?.columns ?? 0 }, (_, index) => columnLabel(index)),
        [grid?.columns]
    );

    if (error) return <ViewerError>This spreadsheet could not be read.</ViewerError>;
    if (!grids || !grid) return <Loading />;

    const gridWidth = ROW_HEADER_WIDTH + columns.length * COLUMN_WIDTH;

    return (
        <div className="flex max-h-[80vh] flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                {grids.length > 1 ? (
                    <div className="flex flex-wrap gap-1">
                        {grids.map((sheet, index) => (
                            <button
                                key={sheet.name}
                                type="button"
                                onClick={() => setActive(index)}
                                className={cn(
                                    "rounded-md px-3 py-1 text-xs transition-colors hover:bg-muted",
                                    index === active
                                        ? "bg-muted font-medium"
                                        : "text-muted-foreground"
                                )}
                            >
                                {sheet.name}
                            </button>
                        ))}
                    </div>
                ) : (
                    <span className="text-xs font-medium text-muted-foreground">Spreadsheet</span>
                )}
                <div className="ml-auto flex items-center gap-2">
                    {!readOnly && cells > EDITABLE_CELL_LIMIT ? (
                        <span className="text-xs text-muted-foreground">
                            Preview only (large sheet)
                        </span>
                    ) : null}
                    {editable ? (
                        <EditorActions
                            target={target}
                            dirty={dirty}
                            exportAs={exportAs}
                            exportExtension={exportExtension}
                            onSaved={afterSave}
                        />
                    ) : null}
                </div>
            </div>
            {exportExtension && editable ? (
                <p className="border-b border-border bg-warning/5 px-3 py-1.5 text-xs text-muted-foreground">
                    {sourceExtension.toUpperCase()} files are saved as a converted .xlsx copy; the
                    original is left untouched.
                </p>
            ) : null}
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
                <div style={{ width: gridWidth }}>
                    <div className="sticky top-0 z-10 flex bg-surface text-xs text-muted-foreground">
                        <div
                            className="shrink-0 border-b border-r border-border"
                            style={{ width: ROW_HEADER_WIDTH, height: ROW_HEIGHT }}
                        />
                        {columns.map((label) => (
                            <div
                                key={label}
                                className="flex shrink-0 items-center justify-center border-b border-r border-border"
                                style={{ width: COLUMN_WIDTH, height: ROW_HEIGHT }}
                            >
                                {label}
                            </div>
                        ))}
                    </div>
                    <div
                        className="relative"
                        style={{ height: rowVirtualizer.getTotalSize(), width: gridWidth }}
                    >
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => (
                            <div
                                key={virtualRow.key}
                                className="absolute left-0 flex"
                                style={{
                                    top: virtualRow.start,
                                    height: ROW_HEIGHT,
                                    width: gridWidth
                                }}
                            >
                                <div
                                    className="flex shrink-0 items-center justify-center border-b border-r border-border bg-surface text-xs text-muted-foreground"
                                    style={{ width: ROW_HEADER_WIDTH }}
                                >
                                    {virtualRow.index + 1}
                                </div>
                                {columns.map((label, column) => (
                                    <input
                                        key={label}
                                        value={grid.rows[virtualRow.index]?.[column] ?? ""}
                                        readOnly={!editable}
                                        spellCheck={false}
                                        onChange={(event) =>
                                            changeCell(virtualRow.index, column, event.target.value)
                                        }
                                        className={cn(
                                            "shrink-0 border-b border-r border-border bg-transparent px-2 text-xs outline-none",
                                            "focus:relative focus:z-10 focus:ring-1 focus:ring-ring",
                                            !editable && "cursor-default"
                                        )}
                                        style={{ width: COLUMN_WIDTH, height: ROW_HEIGHT }}
                                    />
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
