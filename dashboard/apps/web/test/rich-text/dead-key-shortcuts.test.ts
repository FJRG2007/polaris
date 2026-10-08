// @vitest-environment jsdom
/**
 * Markdown shortcuts typed on a keyboard where the backtick is a dead key.
 *
 * On a Spanish layout the closing backtick of `this` arrives through a
 * composition rather than as a typed character, and the editor's own rule gave
 * up on it: the message went out with escaped backticks and was drawn as
 * literal text. A real editor is driven here the way the browser drives it -
 * the composed character lands in the document, then `compositionend` fires.
 */

import { Editor } from "@tiptap/core";
import * as md from "@/components/rich-text/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { baseExtensions } from "@/components/rich-text/schema";
import { afterComposition } from "@/components/rich-text/composed-shortcuts";

let editor: Editor | null = null;

afterEach(() => {
    editor?.destroy();
    editor = null;
});

function typedThroughComposition(text: string): Editor {
    editor = new Editor({ element: document.createElement("div"), extensions: baseExtensions("") });
    editor.commands.insertContent(text);
    // ProseMirror goes on calling itself composing for a moment after the
    // browser's event - which is the window the editor's own retry ran in, and
    // what made it give up.
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: text.slice(-1) }));
    const input = (editor.view as unknown as { input: { composing: boolean } }).input;
    input.composing = true;
    setTimeout(() => (input.composing = false), 20);
    return editor;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

describe("a shortcut closed by a dead key", () => {
    it("turns `this` into code once the composition ends", async () => {
        const current = typedThroughComposition("run `test`");
        await settle();
        expect(md.docToMarkdown(current.getJSON())).toBe("run `test`");
        expect(current.getHTML()).toContain("<code>test</code>");
    });

    it("still finds it when more was typed before the composition closed", async () => {
        const current = typedThroughComposition("run `test`");
        current.view.dispatch(current.state.tr.insertText(" "));
        current.view.dispatch(current.state.tr.insertText("n"));
        await settle();
        expect(md.docToMarkdown(current.getJSON())).toBe("run `test` n");
    });

    it("turns ~~this~~ into a strike the same way", async () => {
        const current = typedThroughComposition("a ~~gone~~");
        await settle();
        expect(current.getHTML()).toContain("<s>gone</s>");
    });

    it("leaves a lone backtick alone", async () => {
        const current = typedThroughComposition("use `");
        await settle();
        expect(current.getHTML()).not.toContain("<code>");
        expect(md.docToMarkdown(current.getJSON())).toBe("use \\`");
    });

    it("holds a send that comes straight after until it has applied", async () => {
        const current = typedThroughComposition("x `key`");
        let sent: string | null = null;
        afterComposition(current.view, () => {
            sent = md.docToMarkdown(current.getJSON());
        });
        expect(sent).toBeNull();
        await settle();
        expect(sent).toBe("x `key`");
    });

    it("sends at once when nothing is being composed", () => {
        editor = new Editor({
            element: document.createElement("div"),
            extensions: baseExtensions("")
        });
        let sent = false;
        afterComposition(editor.view, () => (sent = true));
        expect(sent).toBe(true);
    });
});

/** Characters landing one at a time without the editor's rules seeing them -
 *  how a dead key's character arrives on some systems and browsers. */
function insertedPlainly(text: string, into?: Editor): Editor {
    const current =
        into ??
        new Editor({ element: document.createElement("div"), extensions: baseExtensions("") });
    editor = current;
    for (const char of text) current.view.dispatch(current.state.tr.insertText(char));
    return current;
}

describe("a shortcut whose closing character the rules never saw", () => {
    it("turns `this` into code as soon as it is closed", () => {
        const current = insertedPlainly("`test`");
        expect(current.getHTML()).toContain("<code>test</code>");
        expect(md.docToMarkdown(current.getJSON())).toBe("`test`");
    });

    it("keeps writing outside the code after it", () => {
        const current = insertedPlainly("run `npm i` now");
        expect(md.docToMarkdown(current.getJSON())).toBe("run `npm i` now");
    });

    it("turns ~~this~~ into a strike", () => {
        const current = insertedPlainly("a ~~gone~~");
        expect(current.getHTML()).toContain("<s>gone</s>");
    });

    it("leaves a lone backtick, an empty pair and a spaced pair alone", () => {
        for (const text of ["use `", "``", "` `"]) {
            const current = insertedPlainly(text);
            expect(current.getHTML()).not.toContain("<code>");
            current.destroy();
        }
    });

    it("does not rewrite text that was loaded rather than typed", () => {
        editor = new Editor({
            element: document.createElement("div"),
            extensions: baseExtensions("")
        });
        editor.commands.insertContent("kept `as typed`");
        expect(editor.getHTML()).not.toContain("<code>");
    });

    it("does not redo a shortcut that was undone", () => {
        const current = insertedPlainly("`x`");
        expect(current.getHTML()).toContain("<code>x</code>");
        current.commands.undo();
        current.commands.redo();
        current.commands.undo();
        expect(current.getHTML()).not.toContain("<code>x</code>");
    });

    it("keeps the pair as text when Backspace takes the shortcut back", () => {
        for (const [text, mark] of [
            ["`x`", "<code>"],
            ["a ~~gone~~", "<s>"]
        ] as const) {
            const current = new Editor({
                element: document.createElement("div"),
                extensions: baseExtensions("")
            });
            editor = current;
            current.commands.insertContent(text.slice(0, -1));
            const at = current.state.selection.from;
            current.view.someProp("handleTextInput", (handle) =>
                handle(current.view, at, at, text.slice(-1))
            );
            expect(current.getHTML()).toContain(mark);
            const backspace = new KeyboardEvent("keydown", { key: "Backspace" });
            current.view.someProp("handleKeyDown", (handle) => handle(current.view, backspace));
            expect(current.getHTML()).not.toContain(mark);
            expect(current.state.doc.textContent).toBe(text);
            current.destroy();
        }
    });

    it("turns a pair typed first and filled in after into code", () => {
        // A dead key pressed twice gives both backticks; the word goes between.
        const current = insertedPlainly("run ``");
        const at = current.state.selection.from - 1;
        current.commands.setTextSelection(at);
        insertedPlainly("test", current);
        expect(current.getHTML()).toContain("<code>test</code>");
        expect(md.docToMarkdown(current.getJSON())).toBe("run `test`");
    });

    it("keeps the caret in the code while the word is typed, and leaves it after", () => {
        const current = insertedPlainly("``");
        current.commands.setTextSelection(2);
        insertedPlainly("npm i", current);
        expect(md.docToMarkdown(current.getJSON())).toBe("`npm i`");
        current.commands.setTextSelection(current.state.doc.content.size - 1);
        current.view.dispatch(current.state.tr.setStoredMarks([]));
        insertedPlainly(" now", current);
        expect(md.docToMarkdown(current.getJSON())).toBe("`npm i` now");
    });

    it("turns a pair whose opening is typed last into code", () => {
        const current = insertedPlainly("test`");
        current.commands.setTextSelection(1);
        insertedPlainly("`", current);
        expect(md.docToMarkdown(current.getJSON())).toBe("`test`");
    });

    it("turns ~~this~~ filled in between its halves into a strike", () => {
        const current = insertedPlainly("a ~~~~");
        current.commands.setTextSelection(5);
        insertedPlainly("gone", current);
        expect(current.getHTML()).toContain("<s>gone</s>");
    });

    it("leaves backticks kept as text alone when the words between them are edited", () => {
        editor = new Editor({
            element: document.createElement("div"),
            extensions: baseExtensions("")
        });
        const current = editor;
        current.commands.insertContent("kept `as typed`");
        current.commands.setTextSelection(10);
        insertedPlainly("x", current);
        expect(current.getHTML()).not.toContain("<code>");
        expect(current.state.doc.textContent).toBe("kept `as xtyped`");
    });

    it("does not reach into a neighbouring pair when typing between two", () => {
        const current = insertedPlainly("`a` and `b`");
        expect(md.docToMarkdown(current.getJSON())).toBe("`a` and `b`");
        insertedPlainly("!", current);
        expect(md.docToMarkdown(current.getJSON())).toBe("`a` and `b`!");
    });

    it("leaves backticks inside a code block as they are", () => {
        editor = new Editor({
            element: document.createElement("div"),
            extensions: baseExtensions("")
        });
        editor.commands.setCodeBlock();
        insertedPlainly("`a`", editor);
        expect(md.docToMarkdown(editor.getJSON())).toContain("`a`");
        expect(editor.getHTML()).not.toContain("<code>a</code>");
    });
});
