// @vitest-environment jsdom

/**
 * Handing a menu's focus to the field at the top of it.
 *
 * The bug worth pinning is a race, and a race cannot be pinned by opening a menu
 * and looking: whether the field or the surface wins depends on the animation
 * and the machine, so a test that opens one passes on a fast machine whichever
 * way the code is written. What can be pinned is that there is no longer a race
 * to win - the surface being focused is itself what moves the focus on, so the
 * field has the last word in either order.
 *
 * The other two halves matter just as much. A menu with no field in it must be
 * left exactly as it was, or every menu in the dashboard stops holding focus;
 * and focus landing on an option must be left alone, or a menu with a search box
 * becomes the one menu that cannot be walked with the arrow keys.
 */

import type { FocusEvent, PointerEvent } from "react";
import { describe, expect, it } from "vitest";
import { keepSearchFocus, MENU_SEARCH_ATTRIBUTE, redirectMenuFocus } from "../src/lib/menu-search-focus";

/** A surface, and the focus event React would hand its `onFocus`. */
function surface(inner: string): { node: HTMLElement; focused: (target?: HTMLElement) => void } {
    // The page is cleared each time: a field left focused by the test before this
    // one is still the active element, and "nothing took focus" is one of the
    // things being asserted.
    document.body.innerHTML = "";
    const node = document.createElement("div");
    node.tabIndex = -1;
    node.innerHTML = inner;
    document.body.append(node);
    return {
        node,
        focused: (target = node) =>
            redirectMenuFocus({ target, currentTarget: node } as unknown as FocusEvent<HTMLElement>)
    };
}

describe("a menu with a field in it", () => {
    it("passes the focus it was given to the field", () => {
        const { node, focused } = surface(`<input ${MENU_SEARCH_ATTRIBUTE} value="backend" />`);
        focused();
        expect(document.activeElement).toBe(node.querySelector("input"));
    });

    it("selects what is already there, so a reopened menu is typed over", () => {
        const { node, focused } = surface(`<input ${MENU_SEARCH_ATTRIBUTE} value="backend" />`);
        focused();
        const field = node.querySelector("input") as HTMLInputElement;
        expect(field.selectionStart).toBe(0);
        expect(field.selectionEnd).toBe("backend".length);
    });

    it("leaves an option that was stepped onto alone", () => {
        const { node, focused } = surface(
            `<input ${MENU_SEARCH_ATTRIBUTE} /><div role="menuitem" tabindex="-1">Delete</div>`
        );
        const option = node.querySelector("[role='menuitem']") as HTMLElement;
        option.focus();
        focused(option);
        expect(document.activeElement).toBe(option);
    });
});

/** The pointer moving over something inside the surface, as React reports it. */
function moved(node: HTMLElement, target: HTMLElement): boolean {
    let prevented = false;
    keepSearchFocus({
        currentTarget: node,
        target,
        preventDefault: () => {
            prevented = true;
        }
    } as unknown as PointerEvent<HTMLElement>);
    return prevented;
}

describe("hovering a menu with a field in it", () => {
    it("refuses the option the focus it would have taken", () => {
        // The option focuses itself on the pointer moving over it, unless that
        // move was already prevented. Everything else about the hover stands.
        const { node } = surface(
            `<input ${MENU_SEARCH_ATTRIBUTE} /><div role="menuitem" tabindex="-1">backend</div>`
        );
        expect(moved(node, node.querySelector("[role='menuitem']") as HTMLElement)).toBe(true);
    });

    it("still lets a submenu open on hover", () => {
        // A submenu that only opened on a click would be a worse menu than the
        // one this is fixing.
        const { node } = surface(
            `<input ${MENU_SEARCH_ATTRIBUTE} /><div role="menuitem" aria-haspopup="menu">More</div>`
        );
        expect(moved(node, node.querySelector("[role='menuitem']") as HTMLElement)).toBe(false);
    });

    it("says nothing about the space between the options", () => {
        const { node } = surface(`<input ${MENU_SEARCH_ATTRIBUTE} /><div role="menuitem">backend</div>`);
        expect(moved(node, node)).toBe(false);
    });
});

describe("hovering every other menu", () => {
    it("is left exactly as it was", () => {
        // Without a field to protect, an option taking focus on hover is how a
        // menu is supposed to work.
        const { node } = surface(`<div role="menuitem" tabindex="-1">Delete</div>`);
        expect(moved(node, node.querySelector("[role='menuitem']") as HTMLElement)).toBe(false);
    });
});

describe("every other menu", () => {
    it("is left to hold its own focus", () => {
        const { node, focused } = surface("<div role='menuitem'>Delete</div>");
        node.focus();
        focused();
        expect(document.activeElement).toBe(node);
    });
});
