"use client";

/**
 * A spreadsheet.
 *
 * Univer for the engine - Apache-2.0, canvas-rendered, with a real formula
 * engine - which is the same choice the reference suite made and for the same
 * reason: it is the only open-source spreadsheet that is a spreadsheet rather
 * than a grid component.
 *
 * **Collaboration is ours.** Univer's open-source edition has none; that is the
 * half its makers sell. So the bridge is `lib/office/sheet.ts`: the workbook on
 * one side, the shared document on the other, and cells moving between them one
 * at a time. Sending the workbook instead would make every keystroke a change to
 * everything, and whoever saved second would erase whoever saved first.
 *
 * Loaded only in the browser: the engine draws on a canvas and measures fonts as
 * it starts.
 *
 * **The engine's stylesheet is imported at the top, statically.** Everything else
 * about the engine is loaded on demand - it is megabytes, and four of the five
 * kinds of document have no use for it - but its CSS cannot be: a stylesheet
 * imported inside an effect is one the bundler has no idea about, so the grid
 * mounted with no styles at all and drew as a column of bare text. Statically
 * imported it costs one small stylesheet on this route and nothing anywhere
 * else, since this file is only loaded on a spreadsheet.
 */

import "@univerjs/preset-sheets-core/lib/index.css";

import * as Y from "yjs";
import { Loader2 } from "lucide-react";
import { SheetTools } from "./sheet-tools";
import { setNumberFormatter } from "@polaris/core/sheets";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOfficeDocument, REMOTE } from "@/app/(app)/office/use-office-document";
import {
    cellsOf,
    changedCells,
    incomingCells,
    readSheetCellKey,
    type SheetCell
} from "@/lib/office/sheet";

/** Where the cells live in the shared document. */
const CELLS = "cells";

/**
 * The workbook's own shape - its sheets, their names and sizes - kept beside the
 * cells rather than inside them.
 *
 * A snapshot, and last-write-wins, which is honest about what it is: adding a
 * sheet while somebody else renames one is rare enough to lose to, and cell
 * edits, which are not rare, do not go through here at all.
 */
const SHAPE = "shape";

/** How long after the last change the workbook is compared with the document.
 *  The engine reports a command for a selection and a scroll as well as an edit,
 *  so this is mostly about not diffing a workbook on every pointer move. */
const SETTLE_MS = 250;

export function SheetEditor({
    documentId,
    content,
    editable
}: {
    documentId: string;
    content: number[] | null;
    editable: boolean;
}) {
    const { doc } = useOfficeDocument({ documentId, content, editable });
    const cells = useMemo(() => doc.getMap<SheetCell>(CELLS), [doc]);
    const shape = useMemo(() => doc.getMap<unknown>(SHAPE), [doc]);
    const host = useRef<HTMLDivElement | null>(null);
    const [failed, setFailed] = useState("");
    const [ready, setReady] = useState(false);

    /** The engine's facade, once it is up. */
    const api = useRef<UniverFacade | null>(null);
    /** Whether the change being handled came off the wire, so it is not sent
     *  straight back out. */
    const applying = useRef(false);

    useEffect(() => {
        let disposed = false;
        let settle: ReturnType<typeof setTimeout> | null = null;
        let stop: (() => void) | null = null;

        void (async () => {
            try {
                const [{ createUniver, LocaleType, merge, defaultTheme }, sheetsCore, locale] =
                    await Promise.all([
                        import("@univerjs/presets"),
                        import("@univerjs/preset-sheets-core"),
                        import("@univerjs/preset-sheets-core/locales/en-US")
                    ]);
                if (disposed || !host.current) return;

                // The engine's own number formatter, handed to the ported chart
                // code. It asks for one rather than importing the framework,
                // which is what keeps `@polaris/core` free of it - see
                // `setNumberFormatter`.
                setNumberFormatter((format, value) =>
                    String(
                        (sheetsCore as { numfmt?: { format: (f: string, v: number, o: object) => string } })
                            .numfmt?.format(format, value, { throws: false }) ?? value
                    )
                );

                const { univerAPI } = createUniver({
                    locale: LocaleType.EN_US,
                    locales: { [LocaleType.EN_US]: merge({}, locale.default ?? locale) },
                    theme: defaultTheme,
                    presets: [sheetsCore.UniverSheetsCorePreset({ container: host.current })]
                });
                api.current = univerAPI as unknown as UniverFacade;

                // Everything that was stored, put back before anybody sees the
                // grid: a workbook that appears empty and then fills in is one
                // people start typing into over the top of.
                const held = (shape.get("workbook") as object | undefined) ?? {};
                const workbook = univerAPI.createWorkbook(withCells(held, cells));
                if (!editable) workbook.setEditable(false);
                setReady(true);

                /** The workbook as it is now, compared with what is shared, and
                 *  only the differences written. */
                const push = (): void => {
                    if (!editable || applying.current) return;
                    const mine = cellsOf(workbook.getSnapshot() as never);
                    const theirs = new Map(cells.entries());
                    const changes = changedCells(mine, theirs);
                    if (changes.length === 0) return;
                    doc.transact(() => {
                        for (const change of changes) {
                            if (change.cell) cells.set(change.key, change.cell);
                            else cells.delete(change.key);
                        }
                        // The shape travels with them rather than on its own, so
                        // a new sheet and the first cell typed into it arrive
                        // together instead of a cell landing in a sheet nobody
                        // else has yet.
                        shape.set("workbook", withoutCells(workbook.getSnapshot()));
                    });
                };

                const listener = workbook.onCommandExecuted(() => {
                    if (settle) clearTimeout(settle);
                    settle = setTimeout(push, SETTLE_MS);
                });

                /** Somebody else typed. */
                const observe = (_event: unknown, transaction: Y.Transaction): void => {
                    if (transaction.origin !== REMOTE) return;
                    const mine = cellsOf(workbook.getSnapshot() as never);
                    const arriving = incomingCells(mine, new Map(cells.entries()));
                    if (arriving.length === 0) return;
                    applying.current = true;
                    try {
                        for (const change of arriving) {
                            const at = readSheetCellKey(change.key);
                            if (!at) continue;
                            const sheet = workbook.getSheetBySheetId(at.sheetId);
                            // A cell for a sheet this screen does not have yet -
                            // the shape is on its way in the same update, so the
                            // next one will land it.
                            if (!sheet) continue;
                            sheet.getRange(at.row, at.column).setValue(change.cell ?? { v: null });
                        }
                    } finally {
                        applying.current = false;
                    }
                };
                cells.observe(observe);

                stop = () => {
                    listener.dispose();
                    cells.unobserve(observe);
                };
            } catch (caught) {
                console.error("[office] the spreadsheet engine would not start", caught);
                if (!disposed) setFailed("The spreadsheet could not be opened.");
            }
        })();

        return () => {
            disposed = true;
            if (settle) clearTimeout(settle);
            stop?.();
            api.current = null;
        };
    }, [cells, doc, editable, shape]);

    // The sheet the tools act on: the first one, which is the one anybody has
    // when they reach for these.
    const firstSheet = useMemo(() => {
        const held = shape.get("sheets");
        const named = held && typeof held === "object" ? Object.keys(held as object) : [];
        return named[0] ?? "";
    }, [shape, ready]);

    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            {editable && firstSheet ? (
                <SheetTools doc={doc} cells={cells} sheetId={firstSheet} />
            ) : null}
            {/* The engine draws into this and measures it, so it needs a box with
                a height of its own rather than one that grows to fit what it
                draws. */}
            <div ref={host} className="min-h-0 w-full flex-1" />
            {!ready && !failed ? (
                <p className="absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-muted-foreground">
                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                    Opening the spreadsheet
                </p>
            ) : null}
            {failed ? (
                <p role="alert" className="absolute inset-0 flex items-center justify-center px-6 text-center text-[13px] text-danger">
                    {failed}
                </p>
            ) : null}
        </div>
    );
}

/** As much of the engine's facade as this file uses. Written out rather than
 *  imported: the package's own types are enormous, and naming the four methods
 *  says what this depends on. */
interface UniverFacade {
    createWorkbook: (data: object) => UniverWorkbook;
}

interface UniverWorkbook {
    getSnapshot: () => object;
    setEditable: (value: boolean) => unknown;
    onCommandExecuted: (callback: () => void) => { dispose: () => void };
    getSheetBySheetId: (id: string) => { getRange: (row: number, column: number) => { setValue: (value: unknown) => unknown } } | null;
}

/** The stored shape with the stored cells put back into it, which is what the
 *  engine wants to open. */
function withCells(shape: object, cells: Y.Map<SheetCell>): object {
    const workbook = structuredClone(shape) as {
        sheets?: Record<string, { cellData?: Record<string, Record<string, SheetCell>> }>;
    };
    if (!workbook.sheets) return workbook;
    for (const [key, cell] of cells.entries()) {
        const at = readSheetCellKey(key);
        if (!at) continue;
        const sheet = workbook.sheets[at.sheetId];
        if (!sheet) continue;
        sheet.cellData ??= {};
        sheet.cellData[at.row] ??= {};
        sheet.cellData[at.row]![at.column] = cell;
    }
    return workbook;
}

/** And the other way: the shape on its own, so the cells are not stored twice -
 *  once in the map where they merge and once in a snapshot that would overwrite
 *  them. */
function withoutCells(snapshot: object): object {
    const workbook = structuredClone(snapshot) as {
        sheets?: Record<string, { cellData?: unknown }>;
    };
    for (const sheet of Object.values(workbook.sheets ?? {})) {
        if (sheet) sheet.cellData = {};
    }
    return workbook;
}
