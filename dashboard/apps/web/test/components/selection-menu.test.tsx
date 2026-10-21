// @vitest-environment jsdom

/**
 * The right-click menu for selected text.
 *
 * Pinned here: it only takes over when the click is on a selection, it leaves
 * a click some screen already answered alone, Shift keeps the browser's menu,
 * "Ask Polar" hands the selection over as the quote and is not there for an
 * account Polar is not for, and the screens' own menus gain the same options.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@polaris/ui";

const polar = { allowed: true, ask: vi.fn() };

vi.mock("@/components/polar/polar-panel", () => ({ usePolar: () => polar }));

import * as selectionMenu from "@/lib/selection-menu";
import { SelectionMenu } from "@/components/selection-menu";
import { quoteBlock, selectionQuote } from "@/lib/polar/shared";

beforeEach(() => {
    polar.allowed = true;
    polar.ask = vi.fn();
    // A browser that will ask before the page reads the clipboard.
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: async () => "pasted", writeText: async () => undefined }
    });
});

afterEach(() => {
    cleanup();
    document.getSelection()?.removeAllRanges();
});

function page(children?: React.ReactNode) {
    return render(
        <SelectionMenu>
            <main>
                <p data-testid="text">Invoice 4411 is overdue</p>
                <p data-testid="other">Something else</p>
                <input data-testid="field" defaultValue="hello world" />
                {children}
            </main>
        </SelectionMenu>,
        { wrapper: MessagesWrapper }
    );
}

function select(node: Node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
}

/** Right-click `target`, and say whether the browser's own menu survived. */
function rightClick(target: Element, init: MouseEventInit = {}): boolean {
    const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 10,
        clientY: 10,
        ...init
    });
    act(() => {
        target.dispatchEvent(event);
    });
    return !event.defaultPrevented;
}

describe("selection menu", () => {
    it("leaves the browser's menu alone with nothing selected", () => {
        page();
        expect(rightClick(screen.getByTestId("text"))).toBe(true);
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("opens on selected text, with Ask Polar passing the selection as the quote", () => {
        page();
        select(screen.getByTestId("text"));
        expect(rightClick(screen.getByTestId("text"))).toBe(false);
        expect(screen.getByRole("menuitem", { name: /Copy/ })).toBeTruthy();
        expect(screen.getByRole("menuitem", { name: /Search/ })).toBeTruthy();
        fireEvent.click(screen.getByRole("menuitem", { name: "Ask Polar about this" }));
        expect(polar.ask).toHaveBeenCalledWith("Invoice 4411 is overdue");
    });

    it("hides Ask Polar from an account Polar is not for", () => {
        polar.allowed = false;
        page();
        select(screen.getByTestId("text"));
        rightClick(screen.getByTestId("text"));
        expect(screen.getByRole("menuitem", { name: /Copy/ })).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: "Ask Polar about this" })).toBeNull();
    });

    it("selects all of the page's main content, not the shell around it", () => {
        render(
            <SelectionMenu>
                <nav>Rail</nav>
                <main>
                    <p data-testid="text">Invoice 4411 is overdue</p>
                    <p>Due Friday</p>
                </main>
            </SelectionMenu>,
            { wrapper: MessagesWrapper }
        );
        select(screen.getByTestId("text").firstChild!);
        rightClick(screen.getByTestId("text"));
        fireEvent.click(screen.getByRole("menuitem", { name: /Select all/ }));
        const selected = document.getSelection()!.toString();
        expect(selected).toContain("Due Friday");
        expect(selected).not.toContain("Rail");
    });

    it("selects all of a dialog outside the main content", () => {
        render(
            <SelectionMenu>
                <main>Page</main>
                <div role="dialog">
                    <p data-testid="text">Invoice 4411 is overdue</p>
                    <p>Due Friday</p>
                </div>
            </SelectionMenu>,
            { wrapper: MessagesWrapper }
        );
        select(screen.getByTestId("text").firstChild!);
        rightClick(screen.getByTestId("text"));
        fireEvent.click(screen.getByRole("menuitem", { name: /Select all/ }));
        const selected = document.getSelection()!.toString();
        expect(selected).toContain("Due Friday");
        expect(selected).not.toContain("Page");
    });

    it("is not about an old selection somewhere else on the page", () => {
        page();
        select(screen.getByTestId("text"));
        expect(rightClick(screen.getByTestId("other"))).toBe(true);
    });

    it("keeps the browser's menu on Shift+right-click", () => {
        page();
        select(screen.getByTestId("text"));
        expect(rightClick(screen.getByTestId("text"), { shiftKey: true })).toBe(true);
    });

    it("takes a field only when text in it is selected, and offers Paste there", () => {
        page();
        const field = screen.getByTestId("field") as HTMLInputElement;
        field.setSelectionRange(0, 0);
        expect(rightClick(field)).toBe(true);
        field.setSelectionRange(0, 5);
        expect(rightClick(field)).toBe(false);
        expect(screen.getByRole("menuitem", { name: /Paste/ })).toBeTruthy();
    });

    it("never offers a password", () => {
        const field = document.createElement("input");
        field.type = "password";
        field.value = "hunter22";
        document.body.append(field);
        field.setSelectionRange(0, 4);
        expect(selectionMenu.selectionAt(field, document)).toBeNull();
        field.remove();
    });

    it("stands aside for a screen's own menu, which gains Ask Polar instead", () => {
        page(
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <div data-testid="row">
                        <span data-testid="row-text">Row with its own menu</span>
                    </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuItem>Rename</ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>
        );
        select(screen.getByTestId("row-text"));
        rightClick(screen.getByTestId("row-text"));
        expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
        // Only the row's menu is open: ours did not draw its own Search.
        expect(screen.queryByRole("menuitem", { name: /Search/ })).toBeNull();
        fireEvent.click(screen.getByRole("menuitem", { name: "Ask Polar about the selection" }));
        expect(polar.ask).toHaveBeenCalledWith("Row with its own menu");
    });

    it("adds nothing to a screen's menu when no text was selected", () => {
        page(
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <div data-testid="row">Row</div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuItem>Rename</ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>
        );
        rightClick(screen.getByTestId("row"));
        expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: /Ask Polar/ })).toBeNull();
    });
});

describe("selection quote", () => {
    it("is cleaned and capped, and empty is nothing", () => {
        expect(selectionQuote("  \n\t ")).toBeNull();
        expect(selectionQuote("a\r\nb\u0007c")).toBe("a\nb c");
        expect(selectionQuote("x".repeat(9000))?.length).toBe(4000);
    });

    it("quotes every line", () => {
        expect(quoteBlock("one\n\ntwo")).toBe("> one\n>\n> two");
    });
});
