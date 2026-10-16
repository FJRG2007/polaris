// @vitest-environment jsdom

/**
 * A kept submenu must not steal the corner-cutting grace from an open one.
 *
 * A right-click submenu that has been opened once stays mounted and hidden while
 * it is shut (`ContextMenuSub`). Radix decides what a pointer leaving a submenu
 * trigger means by asking that submenu's content where it is, and a hidden one
 * still answers - with a zero-sized box. So passing over a shut neighbour on the
 * way into the open submenu replaced the open one's grace area with a useless
 * one, handed focus back to the menu, and closed the submenu under the pointer.
 * In use that is "point at Mute, head for an option, and the menu gives up".
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger
} from "../src/components/context-menu";

/** Where an open submenu sits: to the right of the menu, from the top down. */
const OPEN_SUBMENU = { left: 200, right: 400, top: 0, bottom: 300 };

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    // What a browser reports: an open submenu has a box, a hidden one is 0x0.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
        this: Element
    ) {
        const sub = this.matches("[data-radix-menu-content][aria-labelledby]");
        const box =
            sub && this.getAttribute("data-state") === "open"
                ? OPEN_SUBMENU
                : { left: 0, right: 0, top: 0, bottom: 0 };
        return {
            ...box,
            x: box.left,
            y: box.top,
            width: box.right - box.left,
            height: box.bottom - box.top,
            toJSON: () => box
        } as DOMRect;
    });
});

afterEach(cleanup);

function Menu() {
    return (
        <ContextMenu>
            <ContextMenuTrigger>row</ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuSub>
                    <ContextMenuSubTrigger>Mute</ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                        <ContextMenuItem>1 hour</ContextMenuItem>
                    </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuSub>
                    <ContextMenuSubTrigger>Notifications</ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                        <ContextMenuItem>All messages</ContextMenuItem>
                    </ContextMenuSubContent>
                </ContextMenuSub>
            </ContextMenuContent>
        </ContextMenu>
    );
}

const mouse = (x: number, y: number) => ({ pointerType: "mouse", clientX: x, clientY: y });

/** Past the menu's open delay. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 150)));

const trigger = (name: string) => screen.getByText(name).closest("[role=menuitem]")!;

describe("a context menu with a kept submenu beside an open one", () => {
    it("keeps the open submenu while the pointer cuts across the kept one towards it", async () => {
        render(<Menu />);
        fireEvent.contextMenu(screen.getByText("row"));

        // Open both once, so both are kept, and end on Mute.
        fireEvent.pointerMove(trigger("Mute"), mouse(100, 10));
        await settle();
        fireEvent.pointerLeave(trigger("Mute"), mouse(100, 25));
        fireEvent.pointerMove(trigger("Notifications"), mouse(100, 40));
        await settle();
        fireEvent.pointerLeave(trigger("Notifications"), mouse(100, 25));
        fireEvent.pointerMove(trigger("Mute"), mouse(100, 10));
        await settle();
        expect(trigger("Mute").getAttribute("data-state")).toBe("open");
        expect(trigger("Notifications").getAttribute("data-state")).toBe("closed");

        // Down and to the right, towards Mute's options, across Notifications.
        fireEvent.pointerLeave(trigger("Mute"), mouse(150, 20));
        fireEvent.pointerMove(trigger("Notifications"), mouse(160, 30));
        fireEvent.pointerLeave(trigger("Notifications"), mouse(170, 32));
        await settle();

        expect(trigger("Mute").getAttribute("data-state")).toBe("open");
        expect(screen.getByText("1 hour").closest("[role=menu]")?.getAttribute("data-state")).toBe(
            "open"
        );
    });
});
