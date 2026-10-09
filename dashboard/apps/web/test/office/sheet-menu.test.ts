/**
 * The data half of the spreadsheet's right-click menu: every word it asks the
 * catalogs for exists in both languages, every icon is one of the dashboard's,
 * and the freeze labels name the row and column the engine would freeze at.
 */

import { describe, expect, it } from "vitest";
import enOffice from "../../messages/en-US/office.json";
import esOffice from "../../messages/es-ES/office.json";
import {
    COUNT_WORDS,
    MENU_WORDS,
    TAB_COLORS,
    columnName,
    freezePoint,
    isDestructive,
    menuIcon,
    optionCommand
} from "@/lib/office/sheet-menu";

type Catalog = { sheetMenu: Record<string, Record<string, unknown> | string> };

describe("sheet menu words", () => {
    for (const [lang, catalog] of [
        ["en-US", enOffice as unknown as Catalog],
        ["es-ES", esOffice as unknown as Catalog]
    ] as const) {
        it(`has every item in ${lang}`, () => {
            const items = catalog.sheetMenu.items as Record<string, string>;
            for (const word of new Set(Object.values(MENU_WORDS))) {
                expect(items[word], word).toBeTruthy();
            }
            const counts = catalog.sheetMenu.count as Record<string, { before: string; after: string }>;
            for (const word of Object.values(COUNT_WORDS)) {
                expect(counts[word]?.before, word).toBeTruthy();
            }
            const colors = catalog.sheetMenu.colors as Record<string, string>;
            for (const color of TAB_COLORS) expect(colors[color.word], color.word).toBeTruthy();
        });
    }
});

describe("sheet menu icons", () => {
    it("draws every item the engine ships on its menus with a dashboard icon", () => {
        const engineIcons = [
            "CopyDoubleIcon",
            "CutIcon",
            "PasteSpecialDoubleIcon",
            "ClearFormatDoubleIcon",
            "InsertDoubleIcon",
            "ReduceDoubleIcon",
            "InsertRowAboveDoubleIcon",
            "LeftInsertColumnDoubleIcon",
            "InsertCellShiftRightDoubleIcon",
            "InsertCellDownDoubleIcon",
            "DeleteCellShiftLeftDoubleIcon",
            "DeleteCellShiftUpDoubleIcon",
            "FreezeToSelectedIcon",
            "FreezeRowIcon",
            "FreezeColumnIcon",
            "CancelFreezeIcon",
            "HideDoubleIcon",
            "EyeOutlineIcon",
            "AdjustWidthDoubleIcon",
            "AutoWidthDoubleIcon"
        ];
        for (const icon of engineIcons) expect(menuIcon({ icon }), icon).not.toBeNull();
    });

    it("gives the sheet tab's items, which the engine leaves bare, an icon", () => {
        expect(menuIcon({ title: "sheets-ui.sheetConfig.rename" })).not.toBeNull();
        expect(menuIcon({ title: "sheets-ui.sheetConfig.delete" })).not.toBeNull();
    });

    it("leaves an unknown item without one rather than guessing", () => {
        expect(menuIcon({ icon: "SomethingNewIcon" })).toBeNull();
    });
});

describe("freeze labels", () => {
    it("names columns the way the grid does", () => {
        expect(columnName(0)).toBe("A");
        expect(columnName(25)).toBe("Z");
        expect(columnName(26)).toBe("AA");
        expect(columnName(701)).toBe("ZZ");
        expect(columnName(702)).toBe("AAA");
    });

    it("freezes above and left of the active cell", () => {
        expect(freezePoint({ row: 4, column: 2 })).toEqual({ row: "4", column: "B" });
        expect(freezePoint({ row: 0, column: 0 })).toEqual({ row: "1", column: "A" });
        expect(freezePoint(null)).toEqual({ row: "1", column: "A" });
    });
});

describe("commands", () => {
    it("lets an option name its own command, then the item's", () => {
        const item = { id: "item", type: 1, selectionsCommandId: "pick" };
        expect(optionCommand(item, { commandId: "own" })).toBe("own");
        expect(optionCommand(item, {})).toBe("pick");
        expect(optionCommand({ id: "item", type: 1 }, {})).toBe("item");
    });

    it("marks the items that throw something away", () => {
        expect(isDestructive("sheets-ui.sheetConfig.delete")).toBe(true);
        expect(isDestructive("sheets-ui.rightClick.copy")).toBe(false);
    });
});
