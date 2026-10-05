// @vitest-environment jsdom

/**
 * The formatting bar on an Office document.
 *
 * The report: a document had no toolbar at all - just the page. These drive the
 * bar against a real editor running the document schema: a press formats the
 * selection and says so, the paragraph style and alignment apply to the block,
 * indent stops at its limits, the undo it is handed is the one it calls, and a
 * link or picture address is asked for in the product's own dialog and refused
 * when it is not a web address.
 */

import { Editor } from "@tiptap/core";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { documentExtensions, MAX_INDENT } from "@/components/rich-text/document-schema";
import {
    FormattingToolbar,
    pointsOf,
    safeAddress
} from "@/components/rich-text/formatting-toolbar";

if (!document.elementFromPoint) document.elementFromPoint = () => null;
if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () =>
        ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;

let editor: Editor;

beforeEach(() => {
    editor = new Editor({
        extensions: documentExtensions(""),
        content: "<p>Hello world</p>"
    });
    // "Hello" selected.
    editor.commands.setTextSelection({ from: 1, to: 6 });
});

afterEach(() => {
    cleanup();
    editor.destroy();
});

function bar(onUndo = vi.fn(), onRedo = vi.fn()) {
    render(<FormattingToolbar editor={editor as never} onUndo={onUndo} onRedo={onRedo} />, {
        wrapper: MessagesWrapper
    });
    return { onUndo, onRedo };
}

describe("the document formatting bar", () => {
    it("is a labelled toolbar", () => {
        bar();
        expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeTruthy();
    });

    it("makes the selection bold, and shows Bold as pressed", () => {
        bar();
        const bold = screen.getByRole("button", { name: "Bold" });
        expect(bold.getAttribute("aria-pressed")).toBe("false");
        act(() => fireEvent.click(bold));
        expect(editor.getHTML()).toContain("<strong>Hello</strong>");
        expect(screen.getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")).toBe(
            "true"
        );
    });

    it("underlines, and centres the paragraph", () => {
        bar();
        act(() => fireEvent.click(screen.getByRole("button", { name: "Underline" })));
        act(() => fireEvent.click(screen.getByRole("button", { name: "Center" })));
        const html = editor.getHTML();
        expect(html).toContain("<u>Hello</u>");
        expect(html).toContain("text-align: center");
        expect(screen.getByRole("button", { name: "Center" }).getAttribute("aria-pressed")).toBe(
            "true"
        );
    });

    it("indents a paragraph one step at a time and stops at the limit", () => {
        bar();
        const outdent = screen.getByRole("button", {
            name: "Decrease indent"
        }) as HTMLButtonElement;
        expect(outdent.disabled).toBe(true);
        for (let step = 0; step < MAX_INDENT + 2; step += 1) {
            act(() => {
                editor.commands.indent();
            });
        }
        expect(editor.getJSON().content?.[0]?.attrs?.indent).toBe(MAX_INDENT);
        expect(
            (screen.getByRole("button", { name: "Increase indent" }) as HTMLButtonElement).disabled
        ).toBe(true);
        act(() => fireEvent.click(screen.getByRole("button", { name: "Decrease indent" })));
        expect(editor.getJSON().content?.[0]?.attrs?.indent).toBe(MAX_INDENT - 1);
    });

    it("nests a list item rather than pushing its text along", () => {
        editor.commands.setContent("<ul><li><p>One</p></li><li><p>Two</p></li></ul>");
        editor.commands.setTextSelection(12);
        bar();
        act(() => fireEvent.click(screen.getByRole("button", { name: "Increase indent" })));
        expect(editor.getHTML()).toMatch(/<li><p>One<\/p><ul><li><p>Two/);
    });

    it("calls the undo and redo it was handed, which are the document's", () => {
        const { onUndo, onRedo } = bar();
        fireEvent.click(screen.getByRole("button", { name: "Undo last change" }));
        fireEvent.click(screen.getByRole("button", { name: "Redo last change" }));
        expect(onUndo).toHaveBeenCalledTimes(1);
        expect(onRedo).toHaveBeenCalledTimes(1);
    });

    it("inserts a table", () => {
        bar();
        act(() => fireEvent.click(screen.getByRole("button", { name: "Insert table" })));
        expect(editor.getHTML()).toContain("<table");
        expect(editor.getHTML()).toContain("<th");
    });

    it("asks for a link in its own dialog and refuses one that is not a web address", () => {
        bar();
        act(() => fireEvent.click(screen.getByRole("button", { name: "Add a link" })));
        const field = screen.getByRole("textbox", { name: "Link address" });
        act(() => fireEvent.change(field, { target: { value: "javascript:alert(1)" } }));
        expect(screen.getByRole("alert").textContent).toContain("https://");
        expect((screen.getByRole("button", { name: "Insert" }) as HTMLButtonElement).disabled).toBe(
            true
        );
        act(() => fireEvent.change(field, { target: { value: "example.com/page" } }));
        act(() => fireEvent.click(screen.getByRole("button", { name: "Insert" })));
        expect(editor.getHTML()).toContain('href="https://example.com/page"');
    });

    it("puts everything in a More menu for a narrow screen", () => {
        bar();
        expect(screen.getByRole("button", { name: "More formatting" })).toBeTruthy();
    });

    it("offers the table's own actions in the More menu when the caret is in one", async () => {
        editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
        bar();
        fireEvent.pointerDown(screen.getByRole("button", { name: "More formatting" }), {
            button: 0,
            ctrlKey: false,
            pointerType: "mouse"
        });
        const table = await screen.findByRole("menuitem", { name: "Table" });
        expect(screen.queryByRole("menuitem", { name: "Insert table" })).toBeNull();
        act(() => fireEvent.click(table));
        const rowBelow = await screen.findByRole("menuitem", { name: "Insert row below" });
        act(() => fireEvent.click(rowBelow));
        expect(editor.getHTML().match(/<tr>/g)).toHaveLength(3);
    });

    it("draws nothing pressable for a reader", () => {
        editor.setEditable(false);
        bar();
        expect((screen.getByRole("button", { name: "Bold" }) as HTMLButtonElement).disabled).toBe(
            true
        );
    });
});

describe("the values the bar accepts", () => {
    it("accepts web and mail links and nothing else", () => {
        expect(safeAddress("example.com", "link")).toBe("https://example.com/");
        expect(safeAddress("mailto:ada@example.com", "link")).toBe("mailto:ada@example.com");
        expect(safeAddress("mailto:ada@example.com", "image")).toBeNull();
        expect(safeAddress("javascript:alert(1)", "link")).toBeNull();
        expect(safeAddress("data:text/html,x", "image")).toBeNull();
        expect(safeAddress("   ", "link")).toBeNull();
    });

    it("reads back only the point sizes it set", () => {
        expect(pointsOf("12pt")).toBe(12);
        expect(pointsOf("16px")).toBeNull();
        expect(pointsOf(undefined)).toBeNull();
    });
});
