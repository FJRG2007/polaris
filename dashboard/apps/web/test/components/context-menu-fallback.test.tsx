// @vitest-environment jsdom

/**
 * Every right-click gets a Polaris menu or nothing, never the browser's.
 *
 * Pinned here: which menu a target gets (field, selection, link, picture,
 * nothing), that a screen's own menu keeps priority, that the selection menu
 * in the shell is asked before the root fallback, that a protected picture
 * offers nothing to copy or save, and that a desktop app's spelling checker
 * turns a misspelled word into suggestions that replace it.
 */

import { MessagesWrapper } from "../setup/i18n";
import * as contextMenu from "@/lib/context-menu/target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenuFallback, fallbackMenuFor } from "@/components/context-menu-fallback";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@polaris/ui";

beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: async () => "pasted", writeText: vi.fn(async () => undefined) }
    });
});

afterEach(() => {
    cleanup();
    document.getSelection()?.removeAllRanges();
    delete (window as { polarisDesktop?: unknown }).polarisDesktop;
});

function rightClick(target: Element, init: MouseEventInit = {}): boolean {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10, ...init });
    act(() => {
        target.dispatchEvent(event);
    });
    return !event.defaultPrevented;
}

function select(node: Node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
}

describe("contextTargetAt", () => {
    function at(html: string, id: string, misspelled: contextMenu.SpellingCheck | null = null) {
        document.body.innerHTML = html;
        return contextMenu.contextTargetAt(document.getElementById(id), document, misspelled);
    }

    it("tells apart a field, a link, a picture, a linked picture and empty space", () => {
        expect(at(`<input id="f" value="hi">`, "f").kind).toBe("field");
        expect(at(`<textarea id="f"></textarea>`, "f").kind).toBe("field");
        expect(at(`<div contenteditable="true"><b id="f">x</b></div>`, "f").kind).toBe("field");
        expect(at(`<a id="l" href="https://example.com/x">x</a>`, "l").kind).toBe("link");
        expect(at(`<img id="i" src="https://example.com/a.png">`, "i")).toMatchObject({ kind: "media", image: { src: "https://example.com/a.png", web: true }, link: null });
        expect(at(`<a href="https://example.com/x"><img id="i" src="https://example.com/a.png"></a>`, "i")).toMatchObject({ kind: "media", link: { href: "https://example.com/x" } });
        expect(at(`<div><span id="e">text</span></div>`, "e").kind).toBe("empty");
        expect(at(`<div role="menu"><span id="m">item</span></div>`, "m").kind).toBe("menu");
    });

    it("does not treat a checkbox or a button input as a text field", () => {
        expect(at(`<input id="c" type="checkbox">`, "c").kind).toBe("empty");
        expect(at(`<input id="c" type="button" value="Go">`, "c").kind).toBe("empty");
    });

    it("offers nothing to save for a protected picture or a live video", () => {
        expect(at(`<div data-no-save><img id="i" src="https://example.com/a.png"></div>`, "i")).toMatchObject({ kind: "media", image: null });
        expect(at(`<video id="v"></video>`, "v")).toMatchObject({ kind: "media", image: null });
        expect(at(`<video id="v" poster="https://example.com/p.jpg"></video>`, "v")).toMatchObject({ kind: "media", image: { src: "https://example.com/p.jpg" } });
        expect(fallbackMenuFor({ kind: "media", image: null, link: null })).toBeNull();
    });

    it("finds the word under the caret, and none in a password", () => {
        document.body.innerHTML = `<input id="f" value="helo world"><input id="p" type="password" value="secret">`;
        const field = document.getElementById("f") as HTMLInputElement;
        field.setSelectionRange(2, 2);
        expect(contextMenu.contextTargetAt(field, document)).toMatchObject({ kind: "field", word: { text: "helo", start: 0, end: 4 }, selected: "" });
        const password = document.getElementById("p") as HTMLInputElement;
        password.setSelectionRange(0, 6);
        expect(contextMenu.contextTargetAt(password, document)).toMatchObject({ kind: "field", word: null, selected: "", password: true });
    });

    it("hands a single misspelled word selected in a field to the spelling menu", () => {
        document.body.innerHTML = `<input id="f" value="helo world">`;
        const field = document.getElementById("f") as HTMLInputElement;
        field.setSelectionRange(0, 4);
        expect(contextMenu.contextTargetAt(field, document).kind).toBe("selection");
        expect(contextMenu.contextTargetAt(field, document, (word) => word === "helo").kind).toBe("field");
    });

    it("reads words with accents and apostrophes", () => {
        expect(contextMenu.wordAround("el camión azul", 5)).toEqual({ text: "camión", start: 3, end: 9 });
        expect(contextMenu.wordAround("don't", 1)?.text).toBe("don't");
        expect(contextMenu.wordAround("a  b", 2)).toBeNull();
        expect(contextMenu.wordAround("123", 1)).toBeNull();
    });
});

describe("layers", () => {
    it("asks the highest priority first and stops at the one that answers", () => {
        const low = vi.fn(() => true);
        const high = vi.fn((_event: MouseEvent, target: contextMenu.ContextTarget) => target.kind === "link");
        const removeLow = contextMenu.addContextLayer(0, low);
        const removeHigh = contextMenu.addContextLayer(10, high);
        document.body.innerHTML = `<a id="l" href="https://example.com">x</a><p id="p">x</p>`;
        expect(rightClick(document.getElementById("l")!)).toBe(false);
        expect(high).toHaveBeenCalledTimes(1);
        expect(low).not.toHaveBeenCalled();
        expect(rightClick(document.getElementById("p")!)).toBe(false);
        expect(low).toHaveBeenCalledTimes(1);
        removeHigh();
        removeLow();
        // With nothing registered the listener is gone too.
        expect(rightClick(document.getElementById("p")!)).toBe(true);
    });
});

describe("ContextMenuFallback", () => {
    function page(children: React.ReactNode) {
        return render(
            <>
                <ContextMenuFallback />
                <main>{children}</main>
            </>,
            { wrapper: MessagesWrapper }
        );
    }

    it("opens the field menu with Paste and Select all, and no Cut or Copy with nothing selected", () => {
        page(<input data-testid="field" defaultValue="hello" />);
        expect(rightClick(screen.getByTestId("field"))).toBe(false);
        expect(screen.getByRole("menuitem", { name: /^Paste/ })).toBeTruthy();
        expect(screen.getByRole("menuitem", { name: /Select all/ })).toBeTruthy();
        expect(screen.getByRole("menuitem", { name: /Undo/ })).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: /^Cut/ })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: /^Copy/ })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: /plain text/ })).toBeNull();
    });

    it("offers Paste as plain text only in a rich field, and nothing that edits a read-only one", () => {
        page(
            <>
                <div data-testid="rich" contentEditable suppressContentEditableWarning>
                    typed
                </div>
                <input data-testid="locked" readOnly defaultValue="fixed" />
            </>
        );
        rightClick(screen.getByTestId("rich"));
        expect(screen.getByRole("menuitem", { name: /plain text/ })).toBeTruthy();
        cleanup();
        page(<input data-testid="locked" readOnly defaultValue="fixed" />);
        rightClick(screen.getByTestId("locked"));
        expect(screen.queryByRole("menuitem", { name: /^Paste/ })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: /Undo/ })).toBeNull();
        expect(screen.getByRole("menuitem", { name: /Select all/ })).toBeTruthy();
    });

    it("opens the picture menu, and nothing for a protected one", () => {
        page(
            <>
                <img data-testid="picture" alt="" src="https://example.com/a.png" />
                <div data-no-save>
                    <img data-testid="protected" alt="" src="https://example.com/b.png" />
                </div>
            </>
        );
        expect(rightClick(screen.getByTestId("picture"))).toBe(false);
        for (const name of [/Open image/, /^Copy image$/, /Save image/, /Copy image address/]) {
            expect(screen.getByRole("menuitem", { name })).toBeTruthy();
        }
        cleanup();
        page(
            <div data-no-save>
                <img data-testid="protected" alt="" src="https://example.com/b.png" />
            </div>
        );
        expect(rightClick(screen.getByTestId("protected"))).toBe(false);
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("opens Copy for selected text and the link menu outside the app's shell", () => {
        page(
            <>
                <p data-testid="text">Invoice 4411</p>
                <a data-testid="link" href="https://example.com/x">x</a>
            </>
        );
        select(screen.getByTestId("text"));
        rightClick(screen.getByTestId("text"));
        expect(screen.getByRole("menuitem", { name: /^Copy/ })).toBeTruthy();
        cleanup();
        document.getSelection()?.removeAllRanges();
        page(<a data-testid="link" href="https://example.com/x">x</a>);
        rightClick(screen.getByTestId("link"));
        expect(screen.getByRole("menuitem", { name: /Copy link address/ })).toBeTruthy();
    });

    it("shows nothing on empty space, and still never the browser's menu", () => {
        page(<p data-testid="text">Nothing here</p>);
        expect(rightClick(screen.getByTestId("text"))).toBe(false);
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("stands aside for a screen's own menu", () => {
        page(
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <input data-testid="row" defaultValue="row" />
                </ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuItem>Row action</ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>
        );
        rightClick(screen.getByTestId("row"));
        expect(screen.getByRole("menuitem", { name: "Row action" })).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: /Select all/ })).toBeNull();
    });

    it("leaves a long press in a field on a touch screen to the platform", () => {
        page(<input data-testid="field" defaultValue="hello" />);
        const field = screen.getByTestId("field");
        const down = new Event("pointerdown", { bubbles: true }) as PointerEvent;
        Object.defineProperty(down, "pointerType", { value: "touch" });
        field.dispatchEvent(down);
        expect(rightClick(field)).toBe(true);
        const mouse = new Event("pointerdown", { bubbles: true }) as PointerEvent;
        Object.defineProperty(mouse, "pointerType", { value: "mouse" });
        field.dispatchEvent(mouse);
        expect(rightClick(field)).toBe(false);
    });

    it("offers the desktop app's spelling suggestions and replaces the word", () => {
        const addToDictionary = vi.fn(async () => true);
        (window as { polarisDesktop?: unknown }).polarisDesktop = desktopWith({
            spelling: (word: string) => ({ misspelled: word === "helo", suggestions: ["hello", "help"] }),
            addToDictionary
        });
        page(<input data-testid="field" defaultValue="helo world" />);
        const field = screen.getByTestId("field") as HTMLInputElement;
        field.setSelectionRange(2, 2);
        rightClick(field);
        expect(screen.getByRole("menuitem", { name: "help" })).toBeTruthy();
        fireEvent.click(screen.getByRole("menuitem", { name: /Add to dictionary/ }));
        expect(addToDictionary).toHaveBeenCalledWith("helo");
        field.setSelectionRange(2, 2);
        rightClick(field);
        fireEvent.click(screen.getByRole("menuitem", { name: "hello" }));
        expect(field.value).toBe("hello world");
    });
});

/** A desktop bridge with every method the page checks for, and `editing`. */
function desktopWith(editing: Record<string, unknown>): unknown {
    const none = () => undefined;
    const bridge: Record<string, unknown> = {
        version: "0.1.49",
        platform: "win32",
        notify: none,
        closeNotice: none,
        pickFolder: none,
        pushLocal: none,
        openWindow: none
    };
    bridge.editing = {
        readClipboard: async () => null,
        writeClipboard: async () => false,
        copyImageAt: async () => false,
        saveImage: async () => false,
        ...editing
    };
    return bridge;
}
