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
// The translation provider asks for the app router, which a test render has none of.
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));

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

    it("opens Polaris's menu on Shift+right-click too, never the browser's", () => {
        page();
        select(screen.getByTestId("text"));
        expect(rightClick(screen.getByTestId("text"), { shiftKey: true })).toBe(false);
        expect(screen.getByRole("menuitem", { name: /^Copy/ })).toBeTruthy();
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

    it("offers Cut and Paste in a field that can be edited", async () => {
        page();
        const field = screen.getByTestId("field") as HTMLInputElement;
        field.focus();
        field.setSelectionRange(0, 5);
        rightClick(field);
        expect(screen.getByRole("menuitem", { name: /Paste/ })).toBeTruthy();
        const written: string[] = [];
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
                readText: async () => "pasted",
                writeText: async (text: string) => void written.push(text)
            }
        });
        // jsdom has no editing commands, so the field's own fallback takes it out.
        document.execCommand = () => false;
        await act(async () => {
            fireEvent.click(screen.getByRole("menuitem", { name: /Cut/ }));
        });
        expect(written).toEqual(["hello"]);
        expect(field.value).toBe(" world");
    });

    it("offers no Cut or Paste in a field that cannot be edited", () => {
        page(<input data-testid="locked" readOnly defaultValue="read only text" />);
        const field = screen.getByTestId("locked") as HTMLInputElement;
        field.setSelectionRange(0, 4);
        rightClick(field);
        expect(screen.getByRole("menuitem", { name: /^Copy/ })).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: /Cut/ })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: /Paste/ })).toBeNull();
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

describe("a link", () => {
    function linkPage() {
        return page(
            <>
                <a data-testid="out" href="https://example.com/docs">docs</a>
                <a data-testid="in" href="/tasks/l/abc">list</a>
                <a data-testid="mail" href="mailto:ana@example.com">Ana</a>
                <a data-testid="js" href="javascript:void(0)">nothing</a>
            </>
        );
    }

    it("opens Polaris's menu for a web link: open elsewhere, copy, ask Polar", () => {
        linkPage();
        expect(rightClick(screen.getByTestId("out"))).toBe(false);
        expect(screen.getByRole("menuitem", { name: "Open in new tab" })).toBeTruthy();
        expect(screen.getByRole("menuitem", { name: "Copy link address" })).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: "Open" })).toBeNull();
        fireEvent.click(screen.getByRole("menuitem", { name: "Ask Polar about it" }));
        expect(polar.ask).toHaveBeenCalledWith("https://example.com/docs");
    });

    it("offers to open a link to this Polaris in place", () => {
        linkPage();
        rightClick(screen.getByTestId("in"));
        expect(screen.getByRole("menuitem", { name: "Open" })).toBeTruthy();
    });

    it("copies a mail link as the bare address", () => {
        expect(
            selectionMenu.linkAt(
                Object.assign(document.createElement("a"), { href: "mailto:ana@example.com" }),
                document
            )?.copyText
        ).toBe("ana@example.com");
    });

    it("leaves a script link to the browser, and takes Shift+right-click on a link", () => {
        linkPage();
        expect(rightClick(screen.getByTestId("js"))).toBe(true);
        expect(rightClick(screen.getByTestId("out"), { shiftKey: true })).toBe(false);
    });

    it("lets selected text inside a link win over the link", () => {
        linkPage();
        select(screen.getByTestId("out"));
        rightClick(screen.getByTestId("out"));
        expect(screen.getByRole("menuitem", { name: /^Copy(?! link)/ })).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: "Copy link address" })).toBeNull();
    });
});

describe("text selected inside a received email", () => {
    it("opens the same menu, without Select all, for what the frame reports", () => {
        page();
        act(() => {
            selectionMenu.openFramedSelection({ x: 40, y: 50, text: "Order 77 shipped" });
        });
        expect(screen.getByRole("menuitem", { name: /Copy/ })).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: /Select all/ })).toBeNull();
        fireEvent.click(screen.getByRole("menuitem", { name: "Ask Polar about this" }));
        expect(polar.ask).toHaveBeenCalledWith("Order 77 shipped");
    });

    it("moves the frame's point onto the page and refuses anything that is not a selection", () => {
        const offset = { left: 100, top: 200 };
        expect(selectionMenu.framedSelection({ x: 5, y: 6, text: "hi" }, offset)).toEqual({
            x: 105,
            y: 206,
            text: "hi"
        });
        expect(selectionMenu.framedSelection(null, offset)).toBeNull();
        expect(selectionMenu.framedSelection("hi", offset)).toBeNull();
        expect(selectionMenu.framedSelection({ x: 5, y: 6, text: "   " }, offset)).toBeNull();
        expect(
            selectionMenu.framedSelection({ x: Number.NaN, y: 6, text: "hi" }, offset)
        ).toBeNull();
        expect(selectionMenu.framedSelection({ x: "5", y: 6, text: "hi" }, offset)).toBeNull();
        expect(selectionMenu.framedSelection({ x: 5, y: 6, text: 7 }, offset)).toBeNull();
        const huge = "a".repeat(selectionMenu.FRAMED_SELECTION_MAX + 1);
        expect(selectionMenu.framedSelection({ x: 5, y: 6, text: huge }, offset)).toBeNull();
    });
});

describe("a link inside a received email", () => {
    const offset = { left: 100, top: 200 };
    const origin = "https://polaris.example";

    it("opens Polaris's link menu for what the frame reports", () => {
        page();
        const found = selectionMenu.framedLink(
            { x: 5, y: 6, href: "https://example.com/track?id=1" },
            offset,
            origin
        );
        expect(found).not.toBeNull();
        act(() => selectionMenu.openFramedLink(found!));
        expect(screen.getByRole("menuitem", { name: "Open in new tab" })).toBeTruthy();
        expect(screen.getByRole("menuitem", { name: "Copy link address" })).toBeTruthy();
    });

    it("parses the address itself and refuses anything but the web and mail", () => {
        expect(
            selectionMenu.framedLink({ x: 5, y: 6, href: "mailto:ana@example.com" }, offset, origin)
        ).toEqual({
            x: 105,
            y: 206,
            href: "mailto:ana@example.com",
            copyText: "ana@example.com",
            internal: false
        });
        expect(
            selectionMenu.framedLink({ x: 0, y: 0, href: `${origin}/tasks` }, offset, origin)
                ?.internal
        ).toBe(true);
        for (const href of ["javascript:alert(1)", "data:text/html,x", "nope", 7])
            expect(selectionMenu.framedLink({ x: 5, y: 6, href }, offset, origin)).toBeNull();
        expect(
            selectionMenu.framedLink({ x: Number.NaN, y: 6, href: origin }, offset, origin)
        ).toBeNull();
        expect(selectionMenu.framedLink(null, offset, origin)).toBeNull();
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
