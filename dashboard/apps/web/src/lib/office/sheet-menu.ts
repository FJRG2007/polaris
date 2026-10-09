/**
 * The spreadsheet's right-click menu, as Polaris draws it.
 *
 * The engine decides what is on the menu - which items exist at a cell, a row
 * header, a column header or a sheet tab, and which are hidden or disabled for
 * the current selection and permissions. Polaris decides how it looks and how
 * it behaves under the pointer, so the menu here is the same menu as everywhere
 * else in the dashboard: its icons, its words in both languages, and the
 * submenu behaviour that does not stack two submenus on top of each other or
 * jump while a hand moves down the list.
 *
 * This file is the part that is only data: the shape the engine hands over, and
 * the translation from its names (title keys, icon names) to Polaris' own.
 * Pure, so it can be asserted without a browser.
 */

import {
    ArrowDownToLine,
    ArrowLeftRight,
    ArrowLeftToLine,
    ArrowRightToLine,
    ArrowUpDown,
    ArrowUpToLine,
    BetweenHorizontalEnd,
    BetweenHorizontalStart,
    BetweenVerticalEnd,
    BetweenVerticalStart,
    ClipboardPaste,
    Copy,
    CopyPlus,
    Eraser,
    Eye,
    EyeOff,
    Grid2x2,
    Hash,
    Lock,
    LockOpen,
    MoveHorizontal,
    MoveVertical,
    PaintBucket,
    Palette,
    PanelLeft,
    PanelTop,
    PanelTopClose,
    Pencil,
    Scissors,
    ShieldCheck,
    Snowflake,
    SquareMinus,
    SquarePlus,
    Trash2,
    type LucideIcon
} from "lucide-react";

/** The engine's kinds of menu item. Numbers, as the engine stores them. */
export const MENU_ITEM = { button: 0, selector: 1, buttonSelector: 2, subitems: 3 } as const;

/** Where a menu was opened. The engine's own position keys. */
export const MENU_AT = {
    cell: "contextMenu.mainArea",
    columnHeader: "contextMenu.colHeader",
    rowHeader: "contextMenu.rowHeader",
    sheetTab: "contextMenu.footerTabs"
} as const;

/** Something that can be subscribed to - the engine's observables, without
 *  naming the library they come from. */
export interface Watchable<T> {
    subscribe: (next: (value: T) => void) => { unsubscribe: () => void };
}

/** A label the engine draws with a component of its own rather than a string. */
export interface LabelComponent {
    name: string;
    props?: Record<string, unknown>;
    selectable?: boolean;
    hoverable?: boolean;
}

export interface MenuOption {
    label?: string | LabelComponent;
    value?: unknown;
    icon?: string;
    commandId?: string;
    disabled?: boolean;
}

/** One item, as the engine describes it. */
export interface MenuItem {
    id: string;
    type: number;
    title?: string;
    tooltip?: string;
    icon?: string;
    label?: string | LabelComponent;
    commandId?: string;
    params?: unknown;
    selections?: MenuOption[] | Watchable<MenuOption[]>;
    selectionsCommandId?: string;
    hidden$?: Watchable<boolean>;
    disabled$?: Watchable<boolean>;
    activated$?: Watchable<boolean>;
    value$?: Watchable<unknown>;
}

/** A node of the engine's menu tree: an item, or a group of them. */
export interface MenuNode {
    key: string;
    order?: number;
    item?: MenuItem;
    children?: MenuNode[];
    title?: string;
    quickLayout?: string;
    tiny?: boolean;
}

/** The catalog keys under `office.sheetMenu.items` and `.count`. */
export type MenuWord =
    | "copy" | "cut" | "paste" | "copySpecial" | "pasteSpecial" | "pasteValue" | "pasteFormat"
    | "pasteColWidth" | "pasteBesidesBorder" | "copyFormula" | "pasteFormula" | "clear" | "clearContent" | "clearFormat" | "clearAll"
    | "textToNumber" | "insert" | "delete" | "shiftLeft" | "shiftUp" | "shiftRight" | "shiftDown"
    | "deleteRows" | "deleteColumns" | "hideRows" | "hideColumns" | "showRows" | "showColumns"
    | "fitContent" | "freeze" | "freezeFirstRow" | "freezeFirstColumn" | "unfreeze" | "protectRange"
    | "addProtection" | "editProtection" | "removeProtection" | "protectedRanges" | "deleteSheet"
    | "duplicateSheet" | "renameSheet" | "tabColor" | "hideSheet" | "unhideSheet" | "protectSheet"
    | "unprotectSheet" | "sheetPermissions";
export type CountWord = "rowsAbove" | "rowsBelow" | "columnsLeft" | "columnsRight" | "columnWidth" | "rowHeight";

/** The engine's two label components this menu draws itself. */
export const INPUT_LABEL = /_MENU_ITEM_INPUT_COMPONENT$/;
export const FROZEN_LABEL = /_MENU_ITEM_FROZEN_COMPONENT$/;
/** The colour grid a sheet tab's "Change colour" opens. */
export const COLOR_LABEL = /COLOR_PICKER/i;

/**
 * Words, by the engine's title key.
 *
 * Every label on this menu comes from Polaris' catalogs (`office.sheetMenu`), so
 * it reads in the reader's language and in the same voice as the rest of the
 * dashboard. A key missing here falls back to the engine's own words, which is
 * what a new item from a plugin gets until it is added.
 */
export const MENU_WORDS: Record<string, MenuWord> = {
    "sheets-ui.rightClick.copy": "copy",
    "sheets-ui.rightClick.cut": "cut",
    "sheets-ui.rightClick.paste": "paste",
    "sheets-ui.rightClick.copySpecial": "copySpecial",
    "sheets-ui.rightClick.pasteSpecial": "pasteSpecial",
    "sheets-ui.rightClick.pasteValue": "pasteValue",
    "sheets-ui.rightClick.pasteFormat": "pasteFormat",
    "sheets-ui.rightClick.pasteColWidth": "pasteColWidth",
    "sheets-ui.rightClick.pasteBesidesBorder": "pasteBesidesBorder",
    "sheets-formula-ui.operation.copyFormulaOnly": "copyFormula",
    "sheets-formula-ui.operation.pasteFormula": "pasteFormula",
    "formula.operation.pasteFormula": "pasteFormula",
    "sheets-ui.rightClick.clearSelection": "clear",
    "sheets-ui.rightClick.clearContent": "clearContent",
    "sheets-ui.rightClick.clearFormat": "clearFormat",
    "sheets-ui.rightClick.clearAll": "clearAll",
    "sheets-ui.rightClick.textToNumber": "textToNumber",
    "sheets-ui.toolbar.textToNumber": "textToNumber",
    "sheets-ui.rightClick.insert": "insert",
    "sheets-ui.rightClick.delete": "delete",
    "sheets-ui.rightClick.moveLeft": "shiftLeft",
    "sheets-ui.rightClick.moveUp": "shiftUp",
    "sheets-ui.rightClick.moveRight": "shiftRight",
    "sheets-ui.rightClick.moveDown": "shiftDown",
    "sheets-ui.rightClick.deleteSelectedRow": "deleteRows",
    "sheets-ui.rightClick.deleteSelectedColumn": "deleteColumns",
    "sheets-ui.rightClick.hideSelectedRow": "hideRows",
    "sheets-ui.rightClick.hideSelectedColumn": "hideColumns",
    "sheets-ui.rightClick.showHideRow": "showRows",
    "sheets-ui.rightClick.showHideColumn": "showColumns",
    "sheets-ui.rightClick.fitContent": "fitContent",
    "sheets-ui.rightClick.freeze": "freeze",
    "sheets-ui.rightClick.freezeFirstRow": "freezeFirstRow",
    "sheets-ui.rightClick.freezeFirstCol": "freezeFirstColumn",
    "sheets-ui.rightClick.cancelFreeze": "unfreeze",
    "sheets-ui.rightClick.protectRange": "protectRange",
    "sheets-ui.rightClick.turnOnProtectRange": "addProtection",
    "sheets-ui.rightClick.editProtectRange": "editProtection",
    "sheets-ui.rightClick.removeProtectRange": "removeProtection",
    "sheets-ui.rightClick.viewAllProtectArea": "protectedRanges",
    "sheets-ui.sheetConfig.viewAllProtectArea": "protectedRanges",
    "sheets-ui.sheetConfig.delete": "deleteSheet",
    "sheets-ui.sheetConfig.copy": "duplicateSheet",
    "sheets-ui.sheetConfig.rename": "renameSheet",
    "sheets-ui.sheetConfig.changeColor": "tabColor",
    "sheets-ui.sheetConfig.hide": "hideSheet",
    "sheets-ui.sheetConfig.unhide": "unhideSheet",
    "sheets-ui.sheetConfig.addProtectSheet": "protectSheet",
    "sheets-ui.sheetConfig.removeProtectSheet": "unprotectSheet",
    "sheets-ui.sheetConfig.changeSheetPermission": "sheetPermissions"
};

/** The words around an item that carries a number field ("Insert [2] rows
 *  above"), by the engine's prefix key. */
export const COUNT_WORDS: Record<string, CountWord> = {
    "sheets-ui.rightClick.insertRowsAbove": "rowsAbove",
    "sheets-ui.rightClick.insertRowsAfter": "rowsBelow",
    "sheets-ui.rightClick.insertColsLeft": "columnsLeft",
    "sheets-ui.rightClick.insertColsRight": "columnsRight",
    "sheets-ui.rightClick.columnWidth": "columnWidth",
    "sheets-ui.rightClick.rowHeight": "rowHeight"
};

/**
 * Icons, by title key first and by the engine's icon name second.
 *
 * By title first because the engine leaves several items without an icon
 * (everything on a sheet tab) and gives two unrelated items the same one, and a
 * column of icons with gaps in it is harder to scan than one without.
 */
const ICON_BY_TITLE: Record<string, LucideIcon> = {
    "sheets-ui.rightClick.copySpecial": Copy,
    "sheets-ui.rightClick.clearSelection": Eraser,
    "sheets-ui.rightClick.deleteSelectedRow": Trash2,
    "sheets-ui.rightClick.deleteSelectedColumn": Trash2,
    "sheets-ui.rightClick.protectRange": Lock,
    "sheets-ui.sheetConfig.delete": Trash2,
    "sheets-ui.sheetConfig.copy": CopyPlus,
    "sheets-ui.sheetConfig.rename": Pencil,
    "sheets-ui.sheetConfig.changeColor": Palette,
    "sheets-ui.sheetConfig.hide": EyeOff,
    "sheets-ui.sheetConfig.unhide": Eye,
    "sheets-ui.sheetConfig.addProtectSheet": Lock,
    "sheets-ui.sheetConfig.removeProtectSheet": LockOpen,
    "sheets-ui.sheetConfig.changeSheetPermission": ShieldCheck,
    "sheets-ui.sheetConfig.viewAllProtectArea": ShieldCheck,
    "sheets-ui.rightClick.textToNumber": Hash,
    "sheets-ui.toolbar.textToNumber": Hash
};

const ICON_BY_NAME: Record<string, LucideIcon> = {
    CopyDoubleIcon: Copy,
    CutIcon: Scissors,
    PasteSpecialDoubleIcon: ClipboardPaste,
    ClearFormatDoubleIcon: Eraser,
    InsertDoubleIcon: SquarePlus,
    ReduceDoubleIcon: SquareMinus,
    InsertRowAboveDoubleIcon: BetweenHorizontalStart,
    InsertRowBelowDoubleIcon: BetweenHorizontalEnd,
    LeftInsertColumnDoubleIcon: BetweenVerticalStart,
    RightInsertColumnDoubleIcon: BetweenVerticalEnd,
    InsertCellShiftRightDoubleIcon: ArrowRightToLine,
    InsertCellDownDoubleIcon: ArrowDownToLine,
    DeleteCellShiftLeftDoubleIcon: ArrowLeftToLine,
    DeleteCellShiftUpDoubleIcon: ArrowUpToLine,
    DeleteRowDoubleIcon: Trash2,
    DeleteColumnDoubleIcon: Trash2,
    FreezeToSelectedIcon: Snowflake,
    FreezeRowIcon: PanelTop,
    FreezeColumnIcon: PanelLeft,
    CancelFreezeIcon: PanelTopClose,
    HideDoubleIcon: EyeOff,
    EyeOutlineIcon: Eye,
    AdjustWidthDoubleIcon: MoveHorizontal,
    AdjustHeightDoubleIcon: MoveVertical,
    AutoWidthDoubleIcon: ArrowLeftRight,
    AutoHeightDoubleIcon: ArrowUpDown,
    HideGridlinesDoubleIcon: Grid2x2,
    PaintBucketDoubleIcon: PaintBucket,
    LockIcon: Lock
};

/** The icon for an item, or null for one that has none. */
export function menuIcon(item: Pick<MenuItem, "title" | "icon">): LucideIcon | null {
    if (item.title && ICON_BY_TITLE[item.title]) return ICON_BY_TITLE[item.title]!;
    if (item.icon && ICON_BY_NAME[item.icon]) return ICON_BY_NAME[item.icon]!;
    // The lock the engine names after its permission plugin.
    if (item.icon && /lock/i.test(item.icon)) return Lock;
    return null;
}

/** The keys that do the same thing, for the three items everybody knows. */
export const MENU_SHORTCUTS: Record<string, string> = {
    "sheets-ui.rightClick.copy": "Mod+C",
    "sheets-ui.rightClick.cut": "Mod+X",
    "sheets-ui.rightClick.paste": "Mod+V"
};

/** Items that throw something away, drawn in red as every other menu here does. */
export function isDestructive(title: string | undefined): boolean {
    return (
        title === "sheets-ui.sheetConfig.delete" ||
        title === "sheets-ui.rightClick.deleteSelectedRow" ||
        title === "sheets-ui.rightClick.deleteSelectedColumn"
    );
}

/** A column's letters, zero-based: 0 is A, 25 is Z, 26 is AA. */
export function columnName(index: number): string {
    let name = "";
    let at = Math.max(0, Math.floor(index)) + 1;
    while (at > 0) {
        const rest = (at - 1) % 26;
        name = String.fromCharCode(65 + rest) + name;
        at = Math.floor((at - 1) / 26);
    }
    return name;
}

/**
 * Where a freeze would happen, from the active cell.
 *
 * The engine freezes everything above and left of the active cell, so "freeze
 * up to row 3" means rows 1 and 2 stay - the row number shown is the active
 * one, and on the very first row or column the freeze is at the first one.
 */
export function freezePoint(cell: { row: number; column: number } | null): {
    row: string;
    column: string;
} {
    const row = cell?.row ?? 0;
    const column = cell?.column ?? 0;
    return {
        row: String(row === 0 ? 1 : row),
        column: column === 0 ? "A" : columnName(column - 1)
    };
}

/** A tab colour: the swatch drawn and its name in the catalog. */
export interface TabColor {
    readonly hex: string;
    readonly word: "blue" | "teal" | "green" | "yellow" | "orange" | "red" | "pink" | "violet" | "slate" | "black";
}

/** The colours offered for a sheet tab - the same ten the colour picker
 *  suggests everywhere else in Polaris. */
export const TAB_COLORS: readonly TabColor[] = [
    { hex: "#5b8def", word: "blue" },
    { hex: "#3fd0c9", word: "teal" },
    { hex: "#7bc47f", word: "green" },
    { hex: "#e8c26a", word: "yellow" },
    { hex: "#ff9a3c", word: "orange" },
    { hex: "#ff5a5f", word: "red" },
    { hex: "#d94f8a", word: "pink" },
    { hex: "#a06bff", word: "violet" },
    { hex: "#4d5561", word: "slate" },
    { hex: "#20242c", word: "black" }
];

/** Whether any item of a group can be drawn at all. */
export function renderable(node: MenuNode): boolean {
    if (node.item) return true;
    return Boolean(node.children?.some((child) => Boolean(child.item)));
}

/** The selections of an item, whether the engine handed a list or a stream. */
export function staticSelections(item: MenuItem): MenuOption[] | null {
    return Array.isArray(item.selections) ? item.selections : null;
}

/** What an option's command is, which the engine lets an option override. */
export function optionCommand(item: MenuItem, option: MenuOption): string {
    return option.commandId ?? item.selectionsCommandId ?? item.commandId ?? item.id;
}
