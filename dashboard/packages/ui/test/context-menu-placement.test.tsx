// @vitest-environment jsdom

/**
 * Where a context menu opens. Beside the pointer by default, which is what a
 * mouse wants; under the finger and centred on it when asked, which is how a
 * held row's peek on a phone gets the screen's width instead of only the room
 * to one side of the finger.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger
} from "../src/components/context-menu";

afterEach(cleanup);

function open(placement: { side?: "bottom"; align?: "center" }) {
    render(
        <ContextMenu>
            <ContextMenuTrigger>Row</ContextMenuTrigger>
            <ContextMenuContent {...placement} className="w-[min(28rem,calc(100vw_-_2rem))]">
                <ContextMenuItem>Pin</ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
    act(() => {
        fireEvent.contextMenu(screen.getByText("Row"), { clientX: 200, clientY: 300 });
    });
    return screen.getByRole("menu");
}

describe("a context menu's placement", () => {
    it("opens beside the pointer by default", () => {
        const menu = open({});
        expect(menu.getAttribute("data-side")).toBe("right");
        expect(menu.getAttribute("data-align")).toBe("start");
    });

    it("opens under the finger and centred on it, at the width asked for, when told to", () => {
        const menu = open({ side: "bottom", align: "center" });
        expect(menu.getAttribute("data-side")).toBe("bottom");
        expect(menu.getAttribute("data-align")).toBe("center");
        expect(menu.className.split(/\s+/)).toContain("w-[min(28rem,calc(100vw_-_2rem))]");
    });
});
