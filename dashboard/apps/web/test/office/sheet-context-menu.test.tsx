// @vitest-environment jsdom

/**
 * The spreadsheet's right-click menu, driven through a stand-in engine: it
 * opens where the engine says, hides what the engine hides, runs what is
 * chosen with the parameters the engine's own menu would have sent, keeps a
 * number field from choosing its row, and names the tab on a sheet tab's menu.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuNode, Watchable } from "@/lib/office/sheet-menu";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    SheetContextMenu,
    type SheetMenuEngine,
    type SheetMenuHandler
} from "@/app/(app)/office/s/[id]/sheet-context-menu";

function stream<T>(value: T): Watchable<T> & { set: (next: T) => void } {
    const listeners = new Set<(next: T) => void>();
    let current = value;
    return {
        subscribe(next) {
            listeners.add(next);
            next(current);
            return { unsubscribe: () => listeners.delete(next) };
        },
        set(next) {
            current = next;
            for (const listener of listeners) listener(next);
        }
    };
}

const hiddenProtect = stream(true);

const MENUS: Record<string, MenuNode[]> = {
    "contextMenu.mainArea": [
        {
            key: "contextMenu.quick",
            children: [
                { key: "copy", item: { id: "copy", commandId: "sheet.copy", type: 0, title: "sheets-ui.rightClick.copy", icon: "CopyDoubleIcon" } }
            ]
        },
        {
            key: "contextMenu.layout",
            children: [
                { key: "insert", item: { id: "sheet.menu.cell-insert", type: 3, title: "sheets-ui.rightClick.insert", icon: "InsertDoubleIcon" } }
            ]
        },
        {
            key: "contextMenu.others",
            children: [
                { key: "protect", item: { id: "protect", type: 0, title: "sheets-ui.rightClick.protectRange", hidden$: hiddenProtect } }
            ]
        }
    ],
    "sheet.menu.cell-insert": [
        {
            key: "rows",
            item: {
                id: "sheet.command.insert-row-before",
                type: 0,
                icon: "InsertRowAboveDoubleIcon",
                label: {
                    name: "SHEET_UI_MENU_ITEM_INPUT_COMPONENT",
                    props: { prefix: "sheets-ui.rightClick.insertRowsAbove", suffix: "sheets-ui.rightClick.insertRowsAboveSuffix", min: 1, max: 1000 }
                },
                value$: stream(2)
            }
        }
    ],
    "contextMenu.footerTabs": [
        {
            key: "contextMenu.others",
            children: [
                { key: "delete", item: { id: "sheet.command.remove-sheet-confirm", type: 0, title: "sheets-ui.sheetConfig.delete" } },
                {
                    key: "color",
                    item: {
                        id: "sheet.command.set-tab-color",
                        type: 1,
                        title: "sheets-ui.sheetConfig.changeColor",
                        selections: [{ label: { name: "UI_COLOR_PICKER_COMPONENT", selectable: false, hoverable: false } }]
                    }
                }
            ]
        }
    ]
};

function engine() {
    let handler: SheetMenuHandler | null = null;
    const run = vi.fn();
    const fake: SheetMenuEngine = {
        attach: (next) => {
            handler = next;
            return () => (handler = null);
        },
        menu: (position) => MENUS[position] ?? [],
        run,
        focusGrid: vi.fn(),
        engineWords: (key) => key,
        activeCell: () => ({ row: 4, column: 1 }),
        foreignLabel: () => null
    };
    return {
        fake,
        run,
        open: (position: string, extra?: Record<string, unknown>) => act(() => handler!.open({ x: 120, y: 80 }, position, extra)),
        close: () => act(() => handler!.close())
    };
}

afterEach(cleanup);

describe("the spreadsheet's right-click menu", () => {
    it("opens with the dashboard's words and leaves out what the engine hides", async () => {
        const { fake, open } = engine();
        render(<SheetContextMenu engine={fake} />, { wrapper: MessagesWrapper });
        open("contextMenu.mainArea");
        expect(await screen.findByRole("menuitem", { name: /Copy/ })).toBeTruthy();
        expect(screen.getByRole("menuitem", { name: /Insert/ })).toBeTruthy();
        expect(screen.queryByText("Protect range")).toBeNull();
        act(() => hiddenProtect.set(false));
        expect(screen.getByText("Protect range")).toBeTruthy();
        act(() => hiddenProtect.set(true));
    });

    it("closes when the engine asks, and opens again for the next right-click while one is open", async () => {
        const { fake, open, close } = engine();
        render(<SheetContextMenu engine={fake} />, { wrapper: MessagesWrapper });
        open("contextMenu.mainArea");
        expect(await screen.findByRole("menuitem", { name: /Copy/ })).toBeTruthy();
        close();
        expect(screen.queryByRole("menuitem", { name: /Copy/ })).toBeNull();
        open("contextMenu.mainArea");
        expect(await screen.findByRole("menuitem", { name: /Copy/ })).toBeTruthy();
        open("contextMenu.footerTabs", { subUnitId: "sheet-2" });
        expect(await screen.findByRole("menuitem", { name: /Delete/ })).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: /Copy/ })).toBeNull();
    });

    it("runs the chosen command the way the engine's menu would", async () => {
        const { fake, run, open } = engine();
        render(<SheetContextMenu engine={fake} />, { wrapper: MessagesWrapper });
        open("contextMenu.mainArea");
        fireEvent.click(await screen.findByRole("menuitem", { name: /Copy/ }));
        expect(run).toHaveBeenCalledWith("sheet.copy", { value: undefined });
        expect(fake.focusGrid).toHaveBeenCalled();
    });

    it("keeps a press on a number field from choosing its row, and runs it on enter", async () => {
        const { fake, run, open } = engine();
        render(<SheetContextMenu engine={fake} />, { wrapper: MessagesWrapper });
        open("contextMenu.mainArea");
        const trigger = await screen.findByRole("menuitem", { name: /Insert/ });
        fireEvent.keyDown(trigger, { key: "ArrowRight" });
        const field = (await screen.findByRole("spinbutton")) as HTMLInputElement;
        expect(field.value).toBe("2");
        fireEvent.pointerDown(field);
        fireEvent.pointerUp(field);
        fireEvent.click(field);
        expect(run).not.toHaveBeenCalled();
        fireEvent.change(field, { target: { value: "5" } });
        fireEvent.keyDown(field, { key: "Enter" });
        expect(run).toHaveBeenCalledWith("sheet.command.insert-row-before", { value: 5 });
    });

    it("names the tab on a sheet tab's menu and offers colours of its own", async () => {
        const { fake, run, open } = engine();
        render(<SheetContextMenu engine={fake} />, { wrapper: MessagesWrapper });
        open("contextMenu.footerTabs", { subUnitId: "sheet-2" });
        const remove = await screen.findByRole("menuitem", { name: /Delete/ });
        fireEvent.click(remove);
        expect(run).toHaveBeenCalledWith("sheet.command.remove-sheet-confirm", { value: undefined, subUnitId: "sheet-2" });
    });

    it("lists a submenu's options under its name on a phone, where no submenu fits", async () => {
        const narrow = vi.fn().mockReturnValue({ matches: true });
        vi.stubGlobal("matchMedia", narrow);
        try {
            const { fake, run, open } = engine();
            render(<SheetContextMenu engine={fake} />, { wrapper: MessagesWrapper });
            open("contextMenu.footerTabs", { subUnitId: "sheet-2" });
            expect(await screen.findByText("Change color")).toBeTruthy();
            fireEvent.click(screen.getByRole("menuitem", { name: "Blue" }));
            expect(run).toHaveBeenCalledWith("sheet.command.set-tab-color", { value: "#5b8def", subUnitId: "sheet-2" });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("offers the tab colours as swatches with names", async () => {
        const { fake, run, open } = engine();
        render(<SheetContextMenu engine={fake} />, { wrapper: MessagesWrapper });
        open("contextMenu.footerTabs", { subUnitId: "sheet-2" });
        fireEvent.keyDown(await screen.findByRole("menuitem", { name: /Change color/ }), { key: "ArrowRight" });
        fireEvent.click(await screen.findByRole("menuitem", { name: "Blue" }));
        expect(run).toHaveBeenCalledWith("sheet.command.set-tab-color", { value: "#5b8def", subUnitId: "sheet-2" });
    });
});
