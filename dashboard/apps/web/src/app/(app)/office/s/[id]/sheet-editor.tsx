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
import { useTranslations } from "@/components/i18n/i18n-provider";

import * as Y from "yjs";
import { Loader2 } from "lucide-react";
import { SheetTools } from "./sheet-tools";
import { SheetContextMenu, type SheetMenuEngine, type SheetMenuHandler } from "./sheet-context-menu";
import { setNumberFormatter } from "@polaris/core/sheets";
import { polarisUniverTheme } from "@/lib/office/editor-theme";
import { pageIsDark, watchPageTheme } from "@/lib/page-theme";
import { useEffect, useMemo, useRef, useState, type ComponentType, type Context, type ReactNode } from "react";
import type { MenuNode } from "@/lib/office/sheet-menu";
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
    const t = useTranslations("office");
    const { doc } = useOfficeDocument({ documentId, content, editable });
    const cells = useMemo(() => doc.getMap<SheetCell>(CELLS), [doc]);
    const shape = useMemo(() => doc.getMap<unknown>(SHAPE), [doc]);
    const host = useRef<HTMLDivElement | null>(null);
    const [failed, setFailed] = useState("");
    const [ready, setReady] = useState(false);
    const [menuEngine, setMenuEngine] = useState<SheetMenuEngine | null>(null);

    /** The engine's facade, once it is up. */
    const api = useRef<UniverFacade | null>(null);
    /** Whether the change being handled came off the wire, so it is not sent
     *  straight back out. */
    const applying = useRef(false);

    useEffect(() => {
        let disposed = false;
        let settle: ReturnType<typeof setTimeout> | null = null;
        let stop: (() => void) | null = null;
        let unwatchTheme: (() => void) | null = null;

        void (async () => {
            try {
                const [
                    { createUniver, LocaleType, merge, defaultTheme, ICommandService, LocaleService },
                    sheetsCore,
                    locale
                ] =
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

                const { univer, univerAPI } = createUniver({
                    locale: LocaleType.EN_US,
                    locales: { [LocaleType.EN_US]: merge({}, locale.default ?? locale) },
                    // Polaris' own violet and Polaris' own neutrals, and the
                    // page's theme. The engine draws its toolbar, its sheet tabs
                    // and its menus itself, from a palette of its own - left
                    // alone that is a white page and a blue accent, which is an
                    // application somebody embedded rather than a screen of this
                    // one. See `office/univer-theme`.
                    theme: polarisUniverTheme(defaultTheme),
                    darkMode: pageIsDark(),
                    presets: [sheetsCore.UniverSheetsCorePreset({ container: host.current })]
                });
                api.current = univerAPI as unknown as UniverFacade;

                // And it follows the page afterwards. A spreadsheet is a screen
                // somebody leaves open; without this it stays light while
                // everything around it goes dark.
                unwatchTheme = watchPageTheme((dark) =>
                    (univerAPI as unknown as UniverFacade).toggleDarkMode?.(dark)
                );

                // Everything that was stored, put back before anybody sees the
                // grid: a workbook that appears empty and then fills in is one
                // people start typing into over the top of.
                const held = (shape.get("workbook") as object | undefined) ?? {};
                const workbook = univerAPI.createWorkbook(withCells(held, cells));
                if (!editable) workbook.setEditable(false);

                // The right-click menu is Polaris' own (`sheet-context-menu`).
                // Wired once the workbook exists, because that is when the
                // engine's interface services do. It reaches into the engine's
                // internals, so a version that moved them keeps the engine's own
                // menu rather than failing to open the spreadsheet.
                const unwireMenu: (() => void)[] = [];
                try {
                    const ui = sheetsCore as unknown as UniverMenuModule;
                    const injector = (univer as unknown as { __getInjector: () => Injector }).__getInjector();
                    const routed = routeContextMenu(injector, ui);
                    unwireMenu.push(routed.restore);
                    unwireMenu.push(takeRightClicks(host.current, injector, ui, ICommandService, routed));
                    setMenuEngine(menuEngineOf(injector, ui, ICommandService, LocaleService, routed));
                } catch (caught) {
                    console.error("[office] the spreadsheet keeps the engine's own right-click menu", caught);
                    unwireMenu.splice(0).reverse().forEach((undo) => undo());
                }
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
                    unwireMenu.splice(0).reverse().forEach((undo) => undo());
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
            unwatchTheme?.();
            api.current = null;
            setMenuEngine(null);
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
            {menuEngine ? <SheetContextMenu engine={menuEngine} /> : null}
            {!ready && !failed ? (
                <p className="absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-muted-foreground">
                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                    {t("sheetEditor.openingTheSpreadsheet")}
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
    /** Present from 0.6 on. Optional so a version without it is a spreadsheet
     *  that does not follow the theme rather than one that fails to open. */
    toggleDarkMode?: (dark: boolean) => void;
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
/** As much of the engine's interface module as the right-click menu uses. */
interface UniverMenuModule {
    IContextMenuService: unknown;
    IMenuManagerService: unknown;
    ILayoutService: unknown;
    SheetsSelectionsService: unknown;
    SetWorksheetActiveOperation: { id: string };
    RediContext: Context<{ injector: Injector }>;
    CustomLabel: ComponentType<{ label: unknown; value?: unknown; onChange?: (value: unknown) => void }>;
}

/** The engine's context-menu service: what opens a menu, and whether one is open. */
interface EngineContextMenuService {
    triggerContextMenu: (event: PointerEvent | MouseEvent, menuType: string) => void;
    hideContextMenu: () => void;
    readonly visible: boolean;
    disabled: boolean;
}

interface Injector {
    get: (identifier: unknown) => unknown;
}

/** How long a press waits for the browser's right-click event before opening the menu anyway. */
const PRESS_SETTLE_MS = 400;

/** The slot a Polaris menu sits in, shared by the routed service and the menu. */
interface RoutedMenu {
    slot: { handler: SheetMenuHandler | null };
    /** Open the menu a press asked for, now that the gesture is over. */
    flush: () => void;
    /** Put the engine's service back as it was. */
    restore: () => void;
}

/**
 * The engine's context-menu service, with every right-click handed to Polaris.
 *
 * The grid, the row and column headers and every plugin ask this one service to
 * open a menu, so routing it routes all of them at once. Its three entry points
 * are redirected on the live instance - the engine offers no way to replace the
 * service from outside, because the preset does not pass its interface plugin a
 * dependency override - and the engine's own menu, still registered behind it,
 * answers only while no Polaris menu is attached, so a right-click is never lost.
 */
function routeContextMenu(injector: Injector, ui: UniverMenuModule): RoutedMenu {
    const slot: RoutedMenu["slot"] = { handler: null };
    const service = injector.get(ui.IContextMenuService) as EngineContextMenuService;
    const trigger = service.triggerContextMenu.bind(service);
    const hide = service.hideContextMenu.bind(service);
    const visible = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), "visible");
    // The grid asks on the press, while the button is still down. The engine
    // moves focus to its own input on that same press and again on release,
    // and a menu that loses focus closes, so the menu waits for the browser's
    // right-click event, which ends the gesture - or, where none follows, for a
    // moment after the press.
    let pending: { open: () => void; timer: number } | null = null;
    const flush = (): void => {
        if (!pending) return;
        window.clearTimeout(pending.timer);
        const { open } = pending;
        pending = null;
        open();
    };
    service.triggerContextMenu = (event, menuType) => {
        if (!slot.handler) return trigger(event, menuType);
        event.stopPropagation();
        if (service.disabled) return;
        const at = { x: event.clientX, y: event.clientY };
        const open = (): void => slot.handler?.open(at, menuType);
        if (event.type !== "pointerdown" && event.type !== "mousedown") return open();
        if (pending) window.clearTimeout(pending.timer);
        pending = { open, timer: window.setTimeout(flush, PRESS_SETTLE_MS) };
    };
    service.hideContextMenu = () => {
        slot.handler?.close();
        hide();
    };
    Object.defineProperty(service, "visible", {
        configurable: true,
        get: () => Boolean(slot.handler?.isOpen()) || Boolean(visible?.get?.call(service))
    });
    return {
        slot,
        flush,
        restore: () => {
            if (pending) window.clearTimeout(pending.timer);
            pending = null;
            service.triggerContextMenu = trigger;
            service.hideContextMenu = hide;
            delete (service as { visible?: boolean }).visible;
        }
    };
}

/**
 * The browser's own right-click event inside the sheet, taken before anything
 * else on the page sees it.
 *
 * On the grid and its headers the engine opens its menu on the press, so by the
 * time the browser's event arrives Polaris' menu is already open - and a menu
 * treats a right-click outside itself as a request to open again where it
 * landed, which closed the menu it had just opened. That event has nothing left
 * to do there, so it is swallowed.
 *
 * The sheet tabs' menu is opened by the engine's own tab bar rather than through
 * the context-menu service, so on a tab this same event is the gesture itself:
 * the tab is made active as the engine would have made it, and Polaris' menu
 * opens for it instead.
 *
 * Listened for on the window, in the capture phase, because the menu's own
 * listener sits on the document and would otherwise see it first.
 */
function takeRightClicks(
    host: HTMLElement,
    injector: Injector,
    ui: UniverMenuModule,
    commandService: unknown,
    routed: RoutedMenu
): () => void {
    const commands = injector.get(commandService) as {
        executeCommand: (id: string, params?: object) => Promise<unknown>;
    };
    const onContextMenu = (event: MouseEvent): void => {
        const target = event.target;
        if (!routed.slot.handler || !(target instanceof Element) || !host.contains(target)) return;
        if (target instanceof HTMLCanvasElement) {
            event.preventDefault();
            event.stopPropagation();
            routed.flush();
            return;
        }
        const tab = target.closest("[data-u-comp=slide-tab-item]");
        const sheetId = (tab as HTMLElement | null)?.dataset.id;
        if (!tab || !sheetId) return;
        event.preventDefault();
        event.stopPropagation();
        const at = { x: event.clientX, y: event.clientY };
        void commands
            .executeCommand(ui.SetWorksheetActiveOperation.id, { subUnitId: sheetId })
            .then(
                () => routed.slot.handler?.open(at, "contextMenu.footerTabs", { subUnitId: sheetId }),
                (caught: unknown) => console.error("[office] the sheet tab could not be made active", caught)
            );
    };
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => window.removeEventListener("contextmenu", onContextMenu, true);
}

/** Everything Polaris' menu needs from the engine, behind one small interface. */
function menuEngineOf(
    injector: Injector,
    ui: UniverMenuModule,
    commandService: unknown,
    localeService: unknown,
    routed: RoutedMenu
): SheetMenuEngine {
    const menus = injector.get(ui.IMenuManagerService) as {
        getMenuByPositionKey: (key: string) => MenuNode[];
    };
    const commands = injector.get(commandService) as { executeCommand: (id: string, params?: unknown) => unknown };
    const locale = injector.get(localeService) as { t: (key: string, ...args: string[]) => string };
    const layout = injector.get(ui.ILayoutService) as { focus: () => void };
    const selections = injector.get(ui.SheetsSelectionsService) as {
        getCurrentLastSelection: () => {
            primary?: { startRow?: number; startColumn?: number } | null;
            range: { startRow: number; startColumn: number };
        } | null;
    };
    const { RediContext, CustomLabel } = ui;
    return {
        attach: (handler) => {
            routed.slot.handler = handler;
            return () => {
                if (routed.slot.handler === handler) routed.slot.handler = null;
            };
        },
        menu: (position) => menus.getMenuByPositionKey(position),
        run: (commandId, params) => void commands.executeCommand(commandId, params),
        focusGrid: () => layout.focus(),
        engineWords: (key, ...args) => locale.t(key, ...args),
        activeCell: () => {
            const last = selections.getCurrentLastSelection();
            if (!last) return null;
            return {
                row: last.primary?.startRow ?? last.range.startRow,
                column: last.primary?.startColumn ?? last.range.startColumn
            };
        },
        foreignLabel: (label, value, onChange): ReactNode => (
            <RediContext.Provider value={{ injector }}>
                <CustomLabel label={label} value={value} onChange={onChange} />
            </RediContext.Provider>
        )
    };
}
